import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ReleaseEntity } from './entities';
import { RuntimeConfig } from './runtime-config';
import { computeStages } from './stages';

/**
 * DB-driven rollout engine. All control state (tasks, control epochs,
 * in-flight requests) lives in PostgreSQL; the engine keeps no in-process
 * collections of work, so a restart loses nothing.
 */
@Injectable()
export class EngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EngineService.name);
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: RuntimeConfig,
  ) {}

  onModuleInit() {
    this.sweeper = setInterval(() => {
      this.sweepTimeouts().catch((e) => this.logger.error(`sweep failed: ${e.message}`));
    }, this.config.sweepIntervalMs);
  }

  onModuleDestroy() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  /**
   * Dispatch every pending task of the release's current stage exactly once.
   * Claiming is an atomic UPDATE ... WHERE status='pending', so concurrent
   * or repeated invocations can never double-dispatch a task.
   */
  async dispatchDueTasks(releaseId: string): Promise<void> {
    const rel = await this.dataSource.getRepository(ReleaseEntity).findOneBy({ id: releaseId });
    if (!rel || rel.status !== 'running') return;
    const stages = computeStages(rel.nodeIds, rel.strategy, rel.kind);
    const stageNodes = new Set(stages[rel.stageIndex] || []);
    const due: Array<{ id: string; node_id: string; node_name: string; target_cert_id: string; epoch: number }> =
      await this.dataSource.query(
        `SELECT id, node_id, node_name, target_cert_id, epoch FROM release_tasks
         WHERE release_id = $1 AND status = 'pending' ORDER BY created_at`,
        [releaseId],
      );
    for (const task of due) {
      if (!stageNodes.has(task.node_id)) continue;
      const claimed: Array<{ id: string }> = await this.dataSource.query(
        `UPDATE release_tasks
           SET status = 'in_flight', attempts = attempts + 1, updated_at = now()
         WHERE id = $1 AND status = 'pending' RETURNING id`,
        [task.id],
      );
      if (claimed.length === 0) continue; // somebody else claimed it
      const deadline = new Date(Date.now() + rel.strategy.dispatchTimeoutMs);
      const rows: Array<{ id: string }> = await this.dataSource.query(
        `INSERT INTO dispatch_requests
           (release_id, task_id, node_id, epoch, kind, status, cert_id, dispatched_at, deadline_at)
         VALUES ($1,$2,$3,$4,'deploy','in_flight',$5, now(), $6) RETURNING id`,
        [releaseId, task.id, task.node_id, task.epoch, task.target_cert_id, deadline],
      );
      const requestId = rows[0].id;
      await this.dataSource.query(
        `UPDATE release_tasks SET current_request_id = $2 WHERE id = $1`,
        [task.id, requestId],
      );
      await this.postToSimulator({
        requestId,
        nodeId: task.node_id,
        certId: task.target_cert_id,
        releaseId,
      });
    }
  }

  /** Fire-and-forget push to the simulator; failures are left to the sweeper. */
  async postToSimulator(args: {
    requestId: string;
    nodeId: string;
    certId: string;
    releaseId: string;
  }): Promise<void> {
    try {
      const certRows: Array<{ version: number }> = await this.dataSource.query(
        `SELECT version FROM certificates WHERE id = $1`,
        [args.certId],
      );
      await fetch(`${this.config.simulatorUrl}/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: args.requestId,
          nodeId: args.nodeId,
          certId: args.certId,
          certVersion: certRows[0]?.version ?? null,
          callbackUrl: `${this.config.publicBaseUrl}/api/receipts`,
        }),
      });
    } catch (e) {
      this.logger.warn(`dispatch ${args.requestId} to simulator failed: ${e.message}`);
    }
  }

  /**
   * Advance the release state machine after a task transition. Must be
   * called after every applied receipt / timeout / recovery.
   */
  async maybeAdvance(releaseId: string): Promise<void> {
    let dispatch = false;
    await this.dataSource.transaction(async (em) => {
      const rels: ReleaseEntity[] = await em.query(
        `SELECT * FROM releases WHERE id = $1 FOR UPDATE`,
        [releaseId],
      );
      const rel = rels[0] as any;
      if (!rel) return;

      if (rel.status === 'rolling_back') {
        const open = await this.countOpen(em, releaseId, null);
        if (open === 0) {
          await em.query(`UPDATE releases SET status = 'rolled_back', updated_at = now() WHERE id = $1`, [releaseId]);
        }
        return;
      }
      if (rel.status !== 'running') return;

      const stages = computeStages(rel.node_ids, rel.strategy, rel.kind);
      const stageNodes = stages[rel.stage_index] || [];
      const open = await this.countOpen(em, releaseId, stageNodes);
      if (open > 0) return;

      const failed = await this.countByStatus(em, releaseId, stageNodes, 'failed');
      if (failed > 0) {
        await em.query(`UPDATE releases SET status = 'failed', updated_at = now() WHERE id = $1 AND status = 'running'`, [releaseId]);
        return;
      }
      if (rel.stage_index === 0 && stages.length > 1 && rel.kind === 'normal') {
        // gray gate: wait for manual promotion after the canary stage
        await em.query(`UPDATE releases SET status = 'gate_paused', updated_at = now() WHERE id = $1 AND status = 'running'`, [releaseId]);
        return;
      }
      if (rel.stage_index < stages.length - 1) {
        await em.query(`UPDATE releases SET stage_index = stage_index + 1, updated_at = now() WHERE id = $1`, [releaseId]);
        dispatch = true;
        return;
      }
      await em.query(`UPDATE releases SET status = 'completed', updated_at = now() WHERE id = $1`, [releaseId]);
    });
    if (dispatch) await this.dispatchDueTasks(releaseId);
  }

  private async countOpen(em: any, releaseId: string, stageNodes: string[] | null): Promise<number> {
    const rows = stageNodes
      ? await em.query(
          `SELECT count(*)::int AS c FROM release_tasks
           WHERE release_id = $1 AND node_id = ANY($2) AND status IN ('pending','in_flight','restoring')`,
          [releaseId, stageNodes],
        )
      : await em.query(
          `SELECT count(*)::int AS c FROM release_tasks
           WHERE release_id = $1 AND status IN ('pending','in_flight','restoring')`,
          [releaseId],
        );
    return rows[0].c;
  }

  private async countByStatus(em: any, releaseId: string, stageNodes: string[], status: string): Promise<number> {
    const rows = await em.query(
      `SELECT count(*)::int AS c FROM release_tasks
       WHERE release_id = $1 AND node_id = ANY($2) AND status = $3`,
      [releaseId, stageNodes, status],
    );
    return rows[0].c;
  }

  /** Mark overdue in-flight requests as timed out and fail their tasks. */
  async sweepTimeouts(): Promise<void> {
    const expired: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM dispatch_requests WHERE status = 'in_flight' AND deadline_at < now() LIMIT 100`,
    );
    for (const row of expired) {
      let releaseId: string | null = null;
      await this.dataSource.transaction(async (em) => {
        const reqs = await em.query(`SELECT * FROM dispatch_requests WHERE id = $1 FOR UPDATE`, [row.id]);
        const req = reqs[0];
        if (!req || req.status !== 'in_flight') return;
        await em.query(
          `UPDATE dispatch_requests SET status = 'timed_out', completed_at = now() WHERE id = $1`,
          [req.id],
        );
        await em.query(
          `UPDATE release_tasks SET status = 'failed', last_error = 'dispatch timeout', updated_at = now()
           WHERE id = $1 AND status = 'in_flight' AND current_request_id = $2`,
          [req.task_id, req.id],
        );
        releaseId = req.release_id;
      });
      if (releaseId) await this.maybeAdvance(releaseId);
    }
  }

  /**
   * Restart recovery, driven entirely by the database: releases that were
   * mid-execution get their in-flight requests orphaned (their fate is
   * unknowable after a crash) and the affected tasks re-dispatched exactly
   * once. Succeeded tasks are never re-pushed.
   */
  async recover(): Promise<Array<{ releaseId: string; redispatched: number }>> {
    const running: Array<{ id: string; status: string }> = await this.dataSource.query(
      `SELECT id, status FROM releases WHERE status IN ('running','rolling_back') ORDER BY created_at`,
    );
    const summary: Array<{ releaseId: string; redispatched: number }> = [];
    for (const rel of running) {
      const redispatched = await this.dataSource.transaction(async (em) => {
        await em.query(
          `UPDATE dispatch_requests SET status = 'orphaned', completed_at = now()
           WHERE release_id = $1 AND status = 'in_flight'`,
          [rel.id],
        );
        const reset: Array<{ id: string }> = await em.query(
          `UPDATE release_tasks SET status = 'pending', updated_at = now()
           WHERE release_id = $1 AND status = 'in_flight' RETURNING id`,
          [rel.id],
        );
        await em.query(
          `UPDATE release_tasks SET status = 'failed', last_error = 'interrupted by service restart', updated_at = now()
           WHERE release_id = $1 AND status = 'restoring'`,
          [rel.id],
        );
        return reset.length;
      });
      if (rel.status === 'running') await this.dispatchDueTasks(rel.id);
      else await this.maybeAdvance(rel.id);
      summary.push({ releaseId: rel.id, redispatched });
      this.logger.log(`recovered release ${rel.id}: ${redispatched} task(s) re-dispatched`);
    }
    return summary;
  }
}
