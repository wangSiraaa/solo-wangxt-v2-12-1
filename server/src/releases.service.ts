import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  ACTIVE_RELEASE_STATUSES,
  ReleaseEntity,
  ReleaseStrategy,
} from './entities';
import { EngineService } from './engine.service';

const DEFAULT_STRATEGY: ReleaseStrategy = {
  canaryPercent: 25,
  batchSize: 2,
  dispatchTimeoutMs: 3000,
  maxAttempts: 3,
};

@Injectable()
export class ReleasesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly engine: EngineService,
  ) {}

  async createRelease(body: any) {
    if (!body.name) throw new BadRequestException('name is required');
    if (!body.certId) throw new BadRequestException('certId is required');
    if (!Array.isArray(body.nodeIds) || body.nodeIds.length === 0) {
      throw new BadRequestException('nodeIds must be a non-empty array');
    }
    const kind = body.kind === 'emergency' ? 'emergency' : 'normal';
    const certs = await this.dataSource.query(`SELECT id FROM certificates WHERE id = $1`, [body.certId]);
    if (certs.length === 0) throw new BadRequestException(`cert ${body.certId} not found`);
    const nodes = await this.dataSource.query(
      `SELECT id FROM nodes WHERE id = ANY($1)`,
      [body.nodeIds],
    );
    if (nodes.length !== new Set(body.nodeIds).size) {
      throw new BadRequestException('some nodeIds do not exist');
    }
    const strategy: ReleaseStrategy = { ...DEFAULT_STRATEGY, ...(body.strategy || {}) };
    const priority =
      body.priority != null
        ? Number(body.priority)
        : kind === 'emergency'
          ? 100
          : 10;
    const rows = await this.dataSource.query(
      `INSERT INTO releases (name, kind, priority, status, cert_id, strategy, node_ids, created_by)
       VALUES ($1,$2,$3,'draft',$4,$5,$6,$7) RETURNING *`,
      [
        body.name,
        kind,
        priority,
        body.certId,
        JSON.stringify(strategy),
        JSON.stringify(body.nodeIds),
        body.createdBy || 'system',
      ],
    );
    return rows[0];
  }

  /**
   * Start a normal release. Refuses when any target node is controlled by
   * another active release (no implicit takeover for normal releases).
   */
  async start(id: string, operator: string) {
    await this.dataSource.transaction(async (em) => {
      const rel = await this.lockRelease(em, id);
      if (rel.status !== 'draft') throw new ConflictException(`release is ${rel.status}`);
      await this.claimNodes(em, rel, operator, 'schedule');
      await em.query(
        `UPDATE releases SET status = 'running', stage_index = 0, updated_at = now() WHERE id = $1`,
        [id],
      );
    });
    await this.engine.dispatchDueTasks(id);
    return this.getRelease(id);
  }

  /** Conflict preview for an emergency takeover: per-node control info. */
  async takeoverPreview(id: string) {
    const rel = await this.getRelease(id);
    const nodes: any[] = [];
    for (const nodeId of rel.node_ids) {
      const ctl = await this.dataSource.query(
        `SELECT nc.node_id, nc.release_id, nc.epoch, r.name AS release_name, r.kind AS release_kind,
                r.status AS release_status, r.priority AS release_priority
           FROM node_control nc JOIN releases r ON r.id = nc.release_id
          WHERE nc.node_id = $1`,
        [nodeId],
      );
      const nodeRows = await this.dataSource.query(
        `SELECT id, name, current_cert_version FROM nodes WHERE id = $1`,
        [nodeId],
      );
      const control = ctl[0] || null;
      let controllerTask = null;
      let inFlight = 0;
      if (control) {
        const tasks = await this.dataSource.query(
          `SELECT status FROM release_tasks WHERE release_id = $1 AND node_id = $2`,
          [control.release_id, nodeId],
        );
        controllerTask = tasks[0]?.status ?? null;
        const reqs = await this.dataSource.query(
          `SELECT count(*)::int AS c FROM dispatch_requests
           WHERE release_id = $1 AND node_id = $2 AND status = 'in_flight'`,
          [control.release_id, nodeId],
        );
        inFlight = reqs[0].c;
      }
      const activeController =
        control && (ACTIVE_RELEASE_STATUSES as string[]).includes(control.release_status);
      nodes.push({
        nodeId,
        nodeName: nodeRows[0]?.name,
        currentCertVersion: nodeRows[0]?.current_cert_version ?? null,
        controlledBy: control
          ? {
              releaseId: control.release_id,
              releaseName: control.release_name,
              kind: control.release_kind,
              status: control.release_status,
              priority: control.release_priority,
              epoch: control.epoch,
            }
          : null,
        controllerTaskStatus: controllerTask,
        inFlightRequests: inFlight,
        action: !activeController
          ? 'claim'
          : controllerTask === 'success'
            ? 'adopt' // already succeeded under the old plan: control moves, cert untouched
            : 'takeover',
      });
    }
    return {
      releaseId: rel.id,
      releaseName: rel.name,
      kind: rel.kind,
      priority: rel.priority,
      takeoverDone: rel.takeover_done,
      conflicts: nodes.filter((n) => n.action !== 'claim').length,
      nodes,
    };
  }

  /**
   * Atomic emergency takeover. The whole transfer — epoch bumps, switch
   * records, superseding the old plan, task creation — happens in one
   * transaction guarded by row locks, so concurrent confirmations resolve
   * to exactly one winner and duplicate switch logs are impossible.
   */
  async confirmTakeover(id: string, operator: string) {
    await this.dataSource.transaction(async (em) => {
      const rel = await this.lockRelease(em, id);
      if (rel.kind !== 'emergency') {
        throw new BadRequestException('only emergency releases perform takeover');
      }
      if (rel.status !== 'draft' || rel.takeover_done) {
        throw new ConflictException('takeover already confirmed for this release');
      }
      await this.claimNodes(em, rel, operator, 'emergency_takeover');
      await em.query(
        `UPDATE releases SET status = 'running', stage_index = 0, takeover_done = true, updated_at = now()
         WHERE id = $1`,
        [id],
      );
    });
    await this.engine.dispatchDueTasks(id);
    // edge case: every node was adopted (nothing dispatched) -> settle now
    await this.engine.maybeAdvance(id);
    return this.getRelease(id);
  }

  /**
   * Transfer control of every target node to the release inside the current
   * transaction. Nodes are locked in id order to avoid deadlocks.
   */
  private async claimNodes(
    em: EntityManager,
    rel: any,
    operator: string,
    reason: 'schedule' | 'emergency_takeover',
  ) {
    const nodeIds: string[] = [...rel.node_ids].sort();
    // lock node rows (for prev-cert snapshot) and existing control rows
    const nodeRows = await em.query(`SELECT * FROM nodes WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [nodeIds]);
    const nodeById = new Map(nodeRows.map((n: any) => [n.id, n]));
    const controlRows = await em.query(
      `SELECT * FROM node_control WHERE node_id = ANY($1) ORDER BY node_id FOR UPDATE`,
      [nodeIds],
    );
    const controlByNode = new Map(controlRows.map((c: any) => [c.node_id, c]));

    if (reason === 'schedule') {
      const controllerIds = [...new Set(controlRows.map((c: any) => c.release_id))];
      if (controllerIds.length > 0) {
        const active = await em.query(
          `SELECT id, name FROM releases WHERE id = ANY($1) AND status = ANY($2)`,
          [controllerIds, ACTIVE_RELEASE_STATUSES],
        );
        if (active.length > 0) {
          throw new ConflictException({
            message: 'target nodes are controlled by active release(s)',
            conflicts: active.map((a: any) => a.id),
          });
        }
      }
    }

    const affectedReleases = new Set<string>();
    for (const nodeId of rel.node_ids as string[]) {
      const ctl: any = controlByNode.get(nodeId);
      const node: any = nodeById.get(nodeId);
      if (!node) throw new BadRequestException(`node ${nodeId} not found`);
      const newEpoch = (ctl?.epoch ?? 0) + 1;
      if (ctl && ctl.release_id !== rel.id) affectedReleases.add(ctl.release_id);

      await em.query(
        `INSERT INTO node_control (node_id, release_id, epoch, updated_at)
         VALUES ($1,$2,$3, now())
         ON CONFLICT (node_id) DO UPDATE SET release_id = $2, epoch = $3, updated_at = now()`,
        [nodeId, rel.id, newEpoch],
      );
      await em.query(
        `INSERT INTO control_switches
           (node_id, from_release_id, to_release_id, from_epoch, to_epoch, reason, operator)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [nodeId, ctl?.release_id ?? null, rel.id, ctl?.epoch ?? 0, newEpoch, reason, operator || 'system'],
      );

      // adopt nodes that already succeeded under the previous plan: their
      // cert stays untouched and nothing is re-pushed
      let adopted = false;
      if (ctl && ctl.release_id !== rel.id) {
        const prevTasks = await em.query(
          `SELECT status FROM release_tasks WHERE release_id = $1 AND node_id = $2`,
          [ctl.release_id, nodeId],
        );
        adopted = prevTasks[0]?.status === 'success';
      }
      await em.query(
        `INSERT INTO release_tasks
           (release_id, node_id, node_name, status, epoch, target_cert_id, prev_cert_id, attempts, max_attempts, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9)`,
        [
          rel.id,
          nodeId,
          node.name,
          adopted ? 'adopted' : 'pending',
          newEpoch,
          rel.cert_id,
          node.current_cert_id,
          rel.strategy.maxAttempts ?? 3,
          adopted
            ? 'adopted: node already succeeded under the previous plan; cert not overwritten'
            : null,
        ],
      );
    }

    // supersede previously active releases that lost nodes
    if (affectedReleases.size > 0) {
      const ids = [...affectedReleases];
      const actives = await em.query(
        `SELECT id, name FROM releases WHERE id = ANY($1) AND status = ANY($2) FOR UPDATE`,
        [ids, ACTIVE_RELEASE_STATUSES],
      );
      for (const old of actives) {
        await em.query(
          `UPDATE release_tasks SET status = 'superseded', note = $2, updated_at = now()
           WHERE release_id = $1 AND status IN ('pending','in_flight','failed')`,
          [old.id, `superseded by release ${rel.name} (${rel.id})`],
        );
        await em.query(
          `UPDATE dispatch_requests SET status = 'orphaned', completed_at = now()
           WHERE release_id = $1 AND status = 'in_flight'`,
          [old.id],
        );
        await em.query(
          `UPDATE releases
             SET status = 'superseded', superseded_by_release_id = $2,
                 state_reason = $3, updated_at = now()
           WHERE id = $1`,
          [
            old.id,
            rel.id,
            reason === 'emergency_takeover'
              ? `被紧急发布「${rel.name}」接管`
              : `被发布「${rel.name}」取代`,
          ],
        );
      }
    }
  }

  /** Approve the gray gate and continue the rollout. */
  async promote(id: string) {
    await this.dataSource.transaction(async (em) => {
      const rel = await this.lockRelease(em, id);
      if (rel.status !== 'gate_paused') throw new ConflictException(`release is ${rel.status}`);
      await em.query(
        `UPDATE releases SET status = 'running', stage_index = stage_index + 1, updated_at = now() WHERE id = $1`,
        [id],
      );
    });
    await this.engine.dispatchDueTasks(id);
    return this.getRelease(id);
  }

  async pause(id: string) {
    await this.dataSource.transaction(async (em) => {
      const rel = await this.lockRelease(em, id);
      if (rel.status !== 'running') throw new ConflictException(`release is ${rel.status}`);
      await em.query(`UPDATE releases SET status = 'paused', updated_at = now() WHERE id = $1`, [id]);
    });
    return this.getRelease(id);
  }

  async resume(id: string) {
    await this.dataSource.transaction(async (em) => {
      const rel = await this.lockRelease(em, id);
      if (rel.status !== 'paused') throw new ConflictException(`release is ${rel.status}`);
      await em.query(`UPDATE releases SET status = 'running', updated_at = now() WHERE id = $1`, [id]);
    });
    // the current stage may have completed while paused (in-flight receipts
    // are still applied during a pause), so advance first, then dispatch
    await this.engine.maybeAdvance(id);
    await this.engine.dispatchDueTasks(id);
    return this.getRelease(id);
  }

  /** Re-queue failed tasks that still have attempts left. */
  async retry(id: string) {
    const retried = await this.dataSource.transaction(async (em) => {
      const rel = await this.lockRelease(em, id);
      if (rel.status !== 'failed') throw new ConflictException(`release is ${rel.status}`);
      const rows = await em.query(
        `UPDATE release_tasks SET status = 'pending', updated_at = now()
         WHERE release_id = $1 AND status = 'failed' AND attempts < max_attempts RETURNING id`,
        [id],
      );
      if (rows.length === 0) {
        throw new ConflictException('no failed tasks with remaining attempts');
      }
      await em.query(`UPDATE releases SET status = 'running', updated_at = now() WHERE id = $1`, [id]);
      return rows.length;
    });
    await this.engine.dispatchDueTasks(id);
    return { retried };
  }

  /**
   * Roll back: push the previous cert to every node that was successfully
   * updated by this release. In-flight/pending work is stopped first.
   */
  async rollback(id: string, operator: string) {
    await this.dataSource.transaction(async (em) => {
      const rel = await this.lockRelease(em, id);
      if (!['completed', 'failed', 'running', 'gate_paused', 'paused'].includes(rel.status)) {
        throw new ConflictException(`cannot rollback a ${rel.status} release`);
      }
      await em.query(
        `UPDATE release_tasks SET status = 'cancelled', updated_at = now()
         WHERE release_id = $1 AND status IN ('pending','in_flight')`,
        [id],
      );
      await em.query(
        `UPDATE dispatch_requests SET status = 'orphaned', completed_at = now()
         WHERE release_id = $1 AND status = 'in_flight'`,
        [id],
      );
      await this.createRestoreRequests(em, rel, 'rollback');
      await em.query(`UPDATE releases SET status = 'rolling_back', updated_at = now() WHERE id = $1`, [id]);
    });
    await this.dispatchRestoreRequests(id);
    await this.engine.maybeAdvance(id);
    return this.getRelease(id);
  }

  /**
   * Cancel a release. For emergency releases every successfully updated
   * node is restored to the pre-takeover cert when that cert is still valid
   * and matches the node's domains; failed nodes keep their actual version
   * and their failure audit. Superseded plans are never auto-resumed.
   */
  async cancel(id: string, reason: string) {
    await this.dataSource.transaction(async (em) => {
      const rel = await this.lockRelease(em, id);
      const cancellable = [...ACTIVE_RELEASE_STATUSES, 'completed'];
      if (!cancellable.includes(rel.status)) {
        throw new ConflictException(`cannot cancel a ${rel.status} release`);
      }
      await em.query(
        `UPDATE release_tasks SET status = 'cancelled', updated_at = now()
         WHERE release_id = $1 AND status IN ('pending','in_flight')`,
        [id],
      );
      await em.query(
        `UPDATE dispatch_requests SET status = 'orphaned', completed_at = now()
         WHERE release_id = $1 AND status = 'in_flight'`,
        [id],
      );
      if (rel.kind === 'emergency') {
        await this.createRestoreRequests(em, rel, 'restore');
      }
      await em.query(
        `UPDATE releases SET status = 'cancelled', state_reason = $2, updated_at = now() WHERE id = $1`,
        [id, reason || (rel.kind === 'emergency' ? '紧急发布已取消' : '发布已取消')],
      );
    });
    await this.dispatchRestoreRequests(id);
    return this.getRelease(id);
  }

  /**
   * Create per-node restore/rollback dispatch requests for tasks that
   * successfully pushed a cert, returning them to the cert recorded before
   * this release touched the node — but only when that cert is still valid
   * and matches one of the node's domains.
   */
  private async createRestoreRequests(
    em: EntityManager,
    rel: any,
    kind: 'rollback' | 'restore',
  ) {
    const tasks = await em.query(
      `SELECT * FROM release_tasks WHERE release_id = $1 AND status = 'success' FOR UPDATE`,
      [rel.id],
    );
    for (const task of tasks) {
      if (!task.prev_cert_id) {
        await em.query(
          `UPDATE release_tasks SET note = COALESCE(note,'') || ' no previous cert recorded; left as-is', updated_at = now() WHERE id = $1`,
          [task.id],
        );
        continue;
      }
      const certs = await em.query(`SELECT * FROM certificates WHERE id = $1`, [task.prev_cert_id]);
      const nodes = await em.query(`SELECT * FROM nodes WHERE id = $1`, [task.node_id]);
      const cert = certs[0];
      const node = nodes[0];
      const valid =
        cert &&
        cert.status === 'valid' &&
        (!cert.not_after || new Date(cert.not_after).getTime() > Date.now()) &&
        (!cert.not_before || new Date(cert.not_before).getTime() <= Date.now());
      const domainMatches = cert && node && (node.domains || []).includes(cert.domain);
      if (!valid || !domainMatches) {
        await em.query(
          `UPDATE release_tasks
             SET note = COALESCE(note,'') || $2, updated_at = now()
           WHERE id = $1`,
          [
            task.id,
            ` previous cert not restorable (${!valid ? 'no longer valid' : 'domain mismatch'}); node keeps actual version`,
          ],
        );
        continue;
      }
      const deadline = new Date(Date.now() + (rel.strategy.dispatchTimeoutMs ?? 3000));
      const req = await em.query(
        `INSERT INTO dispatch_requests
           (release_id, task_id, node_id, epoch, kind, status, cert_id, dispatched_at, deadline_at)
         VALUES ($1,$2,$3,$4,$5,'in_flight',$6, now(), $7) RETURNING id`,
        [rel.id, task.id, task.node_id, task.epoch, kind, task.prev_cert_id, deadline],
      );
      await em.query(
        `UPDATE release_tasks SET status = 'restoring', current_request_id = $2, updated_at = now() WHERE id = $1`,
        [task.id, req[0].id],
      );
    }
  }

  /** Push newly created restore/rollback requests to the simulator. */
  private async dispatchRestoreRequests(releaseId: string) {
    const reqs = await this.dataSource.query(
      `SELECT id, node_id, cert_id FROM dispatch_requests
       WHERE release_id = $1 AND status = 'in_flight' AND kind IN ('rollback','restore')`,
      [releaseId],
    );
    for (const r of reqs) {
      await this.engine.postToSimulator({
        requestId: r.id,
        nodeId: r.node_id,
        certId: r.cert_id,
        releaseId,
      });
    }
  }

  private async lockRelease(em: EntityManager, id: string): Promise<any> {
    const rows = await em.query(`SELECT * FROM releases WHERE id = $1 FOR UPDATE`, [id]);
    if (rows.length === 0) throw new NotFoundException(`release ${id} not found`);
    return rows[0];
  }

  async getRelease(id: string) {
    const rows = await this.dataSource.query(`SELECT * FROM releases WHERE id = $1`, [id]);
    if (rows.length === 0) throw new NotFoundException(`release ${id} not found`);
    return rows[0];
  }

  async listReleases() {
    return this.dataSource.query(
      `SELECT r.*,
              (SELECT count(*)::int FROM release_tasks t WHERE t.release_id = r.id) AS task_count,
              (SELECT count(*)::int FROM release_tasks t WHERE t.release_id = r.id AND t.status IN ('success','adopted','rolled_back')) AS done_count,
              (SELECT count(*)::int FROM release_tasks t WHERE t.release_id = r.id AND t.status = 'failed') AS failed_count,
              (SELECT name FROM releases s WHERE s.id = r.superseded_by_release_id) AS superseded_by_name
         FROM releases r ORDER BY r.created_at DESC`,
    );
  }

  async releaseDetail(id: string) {
    const rel = await this.getRelease(id);
    const tasks = await this.dataSource.query(
      `SELECT t.*, n.current_cert_version AS node_cert_version
         FROM release_tasks t JOIN nodes n ON n.id = t.node_id
        WHERE t.release_id = $1 ORDER BY t.created_at`,
      [id],
    );
    const switches = await this.dataSource.query(
      `SELECT cs.*, f.name AS from_release_name, t.name AS to_release_name
         FROM control_switches cs
         LEFT JOIN releases f ON f.id = cs.from_release_id
         LEFT JOIN releases t ON t.id = cs.to_release_id
        WHERE cs.from_release_id = $1 OR cs.to_release_id = $1
        ORDER BY cs.created_at`,
      [id],
    );
    const receipts = await this.dataSource.query(
      `SELECT rc.*, n.name AS node_name, r.name AS release_name
         FROM receipts rc
         LEFT JOIN nodes n ON n.id = rc.node_id
         LEFT JOIN releases r ON r.id = rc.release_id
        WHERE rc.release_id = $1 OR rc.request_id IN
          (SELECT id FROM dispatch_requests WHERE release_id = $1)
        ORDER BY rc.received_at DESC LIMIT 200`,
      [id],
    );
    return { ...rel, tasks, switches, receipts };
  }
}
