import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DbClient, DbExecutor } from '../db/types.js';
import { NodeSimulatorService } from '../simulator/node-simulator.service.js';
import { SeedService } from '../seed/seed.service.js';
import { ConflictNode, CreateReleaseDto, ReceiptDto } from './types.js';

interface Row {
  [key: string]: any;
}

@Injectable()
export class ReleasesService implements OnModuleInit {
  private readonly logger = new Logger(ReleasesService.name);
  private ticking = false;
  private readonly inFlightReleases = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DbExecutor,
    private readonly simulator: NodeSimulatorService,
    private readonly seed: SeedService,
  ) {}

  onModuleInit(): void {
    this.simulator.setReceiptCallback(async (receipt) => {
      await this.receiveReceipt(receipt.taskId, {
        success: receipt.success,
        detail: receipt.detail,
      });
    });
    void this.recoverAfterRestart();
  }

  async advance(releaseId: string): Promise<void> {
    await this.advanceRelease(releaseId);
  }

  startScheduler(intervalMs = 180): void {
    if (!this.timer) {
      this.timer = setInterval(() => void this.schedule(), intervalMs);
      this.timer.unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.simulator.clearAfterRestart();
  }

  private async recoverAfterRestart(): Promise<void> {
    await this.seed.seedIfEmpty();
    this.simulator.clearAfterRestart();
    await this.db.transaction(async (tx) => {
      const reset = await tx.query<{ id: string; release_id: string; node_id: string }>(
        `UPDATE tasks SET state = 'requeued', finished_at = now(),
                error = 'process restarted before terminal receipt'
         WHERE state = 'dispatched'
         RETURNING id, release_id, node_id`,
      );
      for (const task of reset.rows) {
        await tx.query(
          `UPDATE release_nodes SET state = 'pending', updated_at = now()
           WHERE release_id = $1 AND node_id = $2 AND state = 'dispatched'`,
          [task.release_id, task.node_id],
        );
        await this.audit(tx, task.release_id, 'restart_requeue', `Node ${task.node_id} had no terminal receipt; requeued exactly once`);
      }

      const restartNodes = await tx.query<{ release_id: string; node_id: string }>(
        `SELECT DISTINCT rn.release_id, rn.node_id
         FROM release_nodes rn JOIN tasks t ON t.release_id = rn.release_id AND t.node_id = rn.node_id
         WHERE t.state = 'requeued' AND rn.state = 'pending'
         ORDER BY rn.release_id, rn.node_id`,
      );
      for (const restartNode of restartNodes.rows) {
        await this.dispatchNode(tx, restartNode.release_id, restartNode.node_id);
      }

      const activeRestores = await tx.query<{ id: string; node_id: string }>(
        `SELECT r.id, rn.node_id
         FROM releases r JOIN release_nodes rn ON rn.release_id = r.id
         WHERE r.state IN ('rolling_back', 'cancelling') AND rn.state = 'restoring'
         ORDER BY r.id, rn.position`,
      );
      for (const restore of activeRestores.rows) {
        await this.dispatchNode(tx, restore.id, restore.node_id);
      }

      const releases = await tx.query<{ id: string; priority: string }>(
        `UPDATE releases
         SET state = CASE WHEN state = 'cancelling' THEN state ELSE
           CASE WHEN priority = 'emergency' AND state IN ('draft', 'waiting_canary', 'paused') THEN 'running' ELSE state END
         END
         WHERE state IN ('running', 'waiting_canary', 'paused', 'cancelling')
         RETURNING id, priority`,
      );
      for (const release of releases.rows) {
        await this.audit(tx, release.id, 'restart_restore_control', 'Control rows and unfinished work recovered from PostgreSQL');
      }
    });
    this.logger.log('Recovered node control and unfinished tasks from PostgreSQL');
  }

  async createNormal(dto: CreateReleaseDto) {
    if (!dto.nodeIds.length) throw new BadRequestException('At least one node is required');
    const cert = await this.seed.ensureCertificate(dto.domain, dto.certVersion);

    return this.db.transaction(async (tx) => {
      await this.lockNodes(tx, dto.nodeIds);
      const conflict = await tx.query<{ release_id: string; node_id: string }>(
        `SELECT nc.release_id, nc.node_id
         FROM node_controls nc
         JOIN releases r ON r.id = nc.release_id
         WHERE nc.node_id = ANY($1)
           AND nc.domain = $2
           AND r.state IN ('waiting_canary', 'paused', 'running')`,
        [dto.nodeIds, dto.domain],
      );
      if (conflict.rows.length) {
        throw new ConflictException(`Nodes already controlled by active release ${conflict.rows[0].release_id}`);
      }
      await tx.query(
        `DELETE FROM node_controls
         WHERE node_id = ANY($1) AND release_id IN (
           SELECT id FROM releases WHERE state NOT IN ('waiting_canary', 'paused', 'running', 'cancelling')
         )`,
        [dto.nodeIds],
      );

      const id = randomUUID();
      const canary = dto.canary !== false && dto.nodeIds.length > 1;
      await tx.query(
        `INSERT INTO releases (id, priority, state, domain, candidate_cert_id, canary_node_id, reason, created_by, started_at)
         VALUES ($1, 'normal', $2, $3, $4, $5, $6, $7, now())`,
        [id, canary ? 'waiting_canary' : 'running', dto.domain, cert.id, dto.nodeIds[0], dto.reason ?? '', dto.createdBy ?? 'operator'],
      );

      for (let index = 0; index < dto.nodeIds.length; index += 1) {
        const node = await this.getNodeForUpdate(tx, dto.nodeIds[index]);
        await tx.query(
          `INSERT INTO release_nodes (release_id, node_id, position, state, previous_cert_id)
           VALUES ($1, $2, $3, 'pending', $4)`,
          [id, node.id, index, node.current_cert_id],
        );
      }
      await tx.query(
        `INSERT INTO node_controls (node_id, release_id, generation, domain)
         SELECT id, $2, 1, $3 FROM nodes WHERE id = ANY($1)`,
        [dto.nodeIds, id, dto.domain],
      );
      await this.audit(tx, id, 'normal_created', `Normal rotation created; canary gate ${canary ? 'enabled' : 'disabled'}`);
      if (canary) {
        await this.dispatchNode(tx, id, dto.nodeIds[0]);
      }
      return this.getRelease(tx, id);
    });
  }

  async previewEmergency(dto: CreateReleaseDto): Promise<{ conflicts: ConflictNode[]; nonOverlappingActive: Row[] }> {
    if (!dto.nodeIds.length) throw new BadRequestException('At least one node is required');
    const releaseIds = await this.db.query<{ id: string }>(
      `SELECT id FROM releases
       WHERE state IN ('waiting_canary', 'paused', 'running') AND priority = 'normal'`,
    );
    if (!releaseIds.rows.length) return { conflicts: [], nonOverlappingActive: [] };

    return this.db.transaction(async (tx) => {
      await this.lockNodes(tx, dto.nodeIds);
      const conflicts = await tx.query<Row>(
        `SELECT n.id AS "nodeId", n.name AS "nodeName", n.domain,
                r.id AS "releaseId", r.state AS "releaseState", r.priority,
                rn.state, nc.generation, n.current_cert_id AS "currentCertId",
                rn.previous_cert_id AS "previousCertId"
         FROM unnest($1::text[]) WITH ORDINALITY AS wanted(node_id, ord)
         JOIN nodes n ON n.id = wanted.node_id
         JOIN node_controls nc ON nc.node_id = n.id AND nc.domain = $2
         JOIN releases r ON r.id = nc.release_id
         JOIN release_nodes rn ON rn.release_id = r.id AND rn.node_id = n.id
         WHERE r.state IN ('waiting_canary', 'paused', 'running') AND r.priority = 'normal'
         ORDER BY wanted.ord`,
        [dto.nodeIds, dto.domain],
      );
      const nonOverlapping = await tx.query<Row>(
        `SELECT r.id, r.state, count(rn.node_id)::int AS node_count
         FROM releases r JOIN release_nodes rn ON rn.release_id = r.id
         WHERE r.state IN ('waiting_canary', 'paused', 'running') AND r.priority = 'normal'
           AND NOT (rn.node_id = ANY($1))
         GROUP BY r.id, r.state`,
        [dto.nodeIds],
      );
      return { conflicts: conflicts.rows as ConflictNode[], nonOverlappingActive: nonOverlapping.rows };
    });
  }

  async confirmEmergency(dto: CreateReleaseDto) {
    if (!dto.nodeIds.length) throw new BadRequestException('At least one node is required');
    const cert = await this.seed.ensureCertificate(dto.domain, dto.certVersion);
    const emergencyId = dto.emergencyReleaseId ?? randomUUID();

    return this.db.transaction(async (tx) => {
      const existing = await tx.query<{ id: string; state: string }>(
        'SELECT id, state FROM releases WHERE id = $1',
        [emergencyId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].state !== 'draft') throw new ConflictException('Emergency release already confirmed');
      } else {
        await tx.query(
          `INSERT INTO releases (id, priority, state, domain, candidate_cert_id, reason, created_by, started_at)
           VALUES ($1, 'emergency', 'running', $2, $3, $4, $5, now())`,
          [emergencyId, dto.domain, cert.id, dto.reason ?? 'Emergency certificate takeover', dto.createdBy ?? 'incident-commander'],
        );
      }

      const sortedNodeIds = [...dto.nodeIds].sort();
      await this.lockNodes(tx, sortedNodeIds);

      const activeEmergency = await tx.query<{ release_id: string }>(
        `SELECT nc.release_id
         FROM node_controls nc JOIN releases r ON r.id = nc.release_id
         WHERE nc.node_id = ANY($1) AND r.priority = 'emergency'
           AND r.state IN ('waiting_canary', 'paused', 'running', 'cancelling')
         LIMIT 1`,
        [sortedNodeIds],
      );
      if (activeEmergency.rows.length) throw new ConflictException(`Another emergency release controls a target: ${activeEmergency.rows[0].release_id}`);

      const controlled = await tx.query<Row>(
        `SELECT nc.*, n.name, rn.state AS node_state, r.id AS release_id
         FROM node_controls nc
         JOIN nodes n ON n.id = nc.node_id
         JOIN release_nodes rn ON rn.release_id = nc.release_id AND rn.node_id = nc.node_id
         JOIN releases r ON r.id = nc.release_id
         WHERE nc.node_id = ANY($1) AND nc.domain = $2
           AND r.priority = 'normal'
           AND r.state IN ('waiting_canary', 'paused', 'running')
         ORDER BY nc.node_id`,
        [sortedNodeIds, dto.domain],
      );

      for (let index = 0; index < sortedNodeIds.length; index += 1) {
        const nodeId = sortedNodeIds[index];
        const node = await this.getNodeForUpdate(tx, nodeId);
        if (node.domain !== dto.domain) throw new BadRequestException(`Node ${nodeId} does not serve ${dto.domain}`);
        const old = controlled.rows.find((row) => row.node_id === nodeId);
        await tx.query(
          `INSERT INTO release_nodes (release_id, node_id, position, state, previous_cert_id)
           VALUES ($1, $2, $3, 'pending', $4)`,
          [emergencyId, nodeId, index, node.current_cert_id],
        );
        if (!old) continue;

        const generation = Number(old.generation) + 1;
        await tx.query(
          `INSERT INTO release_supersessions
             (emergency_release_id, superseded_release_id, node_id, previous_cert_id, reason)
           VALUES ($1, $2, $3, $4, $5)`,
          [emergencyId, old.release_id, nodeId, node.current_cert_id, dto.reason ?? 'Emergency certificate takeover'],
        );
        await tx.query(
          `UPDATE release_nodes SET state = 'superseded', updated_at = now()
           WHERE release_id = $1 AND node_id = $2 AND state IN ('pending', 'dispatched')`,
          [old.release_id, nodeId],
        );
        await tx.query(
          `DELETE FROM node_controls WHERE node_id = $1 AND release_id = $2`,
          [nodeId, old.release_id],
        );
        await tx.query(
          `INSERT INTO node_controls (node_id, release_id, generation, domain)
           VALUES ($1, $2, $3, $4)`,
          [nodeId, emergencyId, generation, dto.domain],
        );
        await this.audit(tx, old.release_id, 'node_superseded', `Node ${nodeId} control generation ${generation}; emergency ${emergencyId}`);
      }

      const oldReleaseIds = Array.from(new Set(controlled.rows.map((row) => row.release_id as string)));
      for (const oldReleaseId of oldReleaseIds) {
        await this.refreshOldReleaseAfterTakeover(tx, oldReleaseId);
      }
      await this.audit(tx, emergencyId, 'emergency_confirmed', `Atomically acquired ${sortedNodeIds.length} target node(s)`);
      const release = await this.getRelease(tx, emergencyId);

      const dispatchNodes = await tx.query<{ node_id: string }>(
        `SELECT node_id FROM release_nodes WHERE release_id = $1 AND state = 'pending' ORDER BY position`,
        [emergencyId],
      );
      for (const row of dispatchNodes.rows) {
        await this.dispatchNode(tx, emergencyId, row.node_id);
      }
      return release;
    });
  }

  async schedule(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.db.query<{ id: string }>(
        `SELECT id FROM releases
         WHERE state IN ('running', 'waiting_canary', 'paused')
         ORDER BY created_at, id`,
      );
      for (const release of due.rows) {
        await this.advanceRelease(release.id);
      }
    } catch (error) {
      this.logger.error(error);
    } finally {
      this.ticking = false;
    }
  }

  private async advanceRelease(releaseId: string) {
    if (this.inFlightReleases.has(releaseId)) return;
    this.inFlightReleases.add(releaseId);
    const dispatchIds: string[] = [];
    try {
      await this.db.transaction(async (tx) => {
        const release = await this.lockRelease(tx, releaseId);
        if (!release || !['running', 'waiting_canary', 'paused'].includes(release.state)) return;

        const nodes = await tx.query<Row>(
          `SELECT rn.*, n.behavior FROM release_nodes rn JOIN nodes n ON n.id = rn.node_id
           WHERE rn.release_id = $1 ORDER BY rn.position`,
          [releaseId],
        );
        const counts = this.countStates(nodes.rows);
        const canaryNodeId = release.canary_node_id;

        if (release.priority === 'normal') {
          const canary = nodes.rows.find((node) => node.node_id === canaryNodeId);
          if (release.state === 'waiting_canary') {
            if (canary && canary.state === 'pending') dispatchIds.push(await this.dispatchNode(tx, releaseId, canaryNodeId));
            return;
          }
          if (canary?.state === 'succeeded' && release.state === 'running' && !release.canary_approved) {
            await tx.query(`UPDATE releases SET state = 'paused', terminal_at = NULL WHERE id = $1`, [releaseId]);
            await this.audit(tx, releaseId, 'canary_gate', `Canary ${canaryNodeId} succeeded; awaiting manual approval`);
            return;
          }
          if (release.state === 'paused') return;
        }

        if (counts.dispatched > 0 || counts.pending === 0) return;
        if (counts.failed > 0) {
          await this.finishRelease(tx, release, counts);
          return;
        }
        const next = nodes.rows.find((node) => node.state === 'pending');
        if (next) dispatchIds.push(await this.dispatchNode(tx, releaseId, next.node_id));
      });
    } finally {
      this.inFlightReleases.delete(releaseId);
    }
  }

  private async dispatchNode(tx: DbClient, releaseId: string, nodeId: string): Promise<string> {
    return this.createTask(tx, releaseId, nodeId, false);
  }

  private async dispatchRestore(tx: DbClient, releaseId: string, nodeId: string): Promise<string> {
    return this.createTask(tx, releaseId, nodeId, true);
  }

  private async createTask(tx: DbClient, releaseId: string, nodeId: string, restore: boolean): Promise<string> {
    const release = await this.lockRelease(tx, releaseId);
    if (!release) throw new NotFoundException(`Release ${releaseId} not found`);
    const node = await this.getNodeForUpdate(tx, nodeId);
    const rn = await tx.query<{ state: string; previous_cert_id: string | null }>(
      `SELECT state, previous_cert_id FROM release_nodes WHERE release_id = $1 AND node_id = $2 FOR UPDATE`,
      [releaseId, nodeId],
    );
    if (!rn.rows[0] || (!restore && rn.rows[0].state !== 'pending') || (restore && rn.rows[0].state !== 'restoring')) {
      throw new ConflictException(`Node ${nodeId} is not dispatchable`);
    }

    let control = await tx.query<{ generation: number; release_id: string }>(
      `SELECT generation, release_id FROM node_controls WHERE node_id = $1 FOR UPDATE`,
      [nodeId],
    );
    if (!control.rows[0]) {
      await tx.query(
        `INSERT INTO node_controls (node_id, release_id, generation, domain)
         VALUES ($1, $2, COALESCE((SELECT max(generation) FROM node_controls WHERE node_id = $1), 0) + 1, $3)`,
        [nodeId, releaseId, release.domain],
      );
      control = await tx.query<{ generation: number; release_id: string }>(
        'SELECT generation, release_id FROM node_controls WHERE node_id = $1 FOR UPDATE',
        [nodeId],
      );
    }
    if (control.rows[0].release_id !== releaseId) throw new ConflictException(`Stale dispatch rejected for ${nodeId}`);

    const attempt = await tx.query<{ max_attempt: number }>(
      'SELECT COALESCE(max(attempt), 0) AS max_attempt FROM tasks WHERE release_id = $1 AND node_id = $2',
      [releaseId, nodeId],
    );
    const taskId = randomUUID();
    const attemptNumber = Number(attempt.rows[0].max_attempt) + 1;
    const targetCertId = restore ? rn.rows[0].previous_cert_id : release.candidate_cert_id;
    await tx.query(
      `INSERT INTO tasks (id, release_id, node_id, generation, cert_id, state, attempt)
       VALUES ($1, $2, $3, $4, $5, 'dispatched', $6)`,
      [taskId, releaseId, nodeId, control.rows[0].generation, targetCertId, attemptNumber],
    );
    await tx.query(
      `UPDATE release_nodes SET state = 'dispatched', failure_reason = '', updated_at = now()
       WHERE release_id = $1 AND node_id = $2`,
      [releaseId, nodeId],
    );
    this.simulator.start({
      id: taskId,
      releaseId,
      nodeId,
      generation: Number(control.rows[0].generation),
      certId: targetCertId,
      attempt: attemptNumber,
    }, node.behavior);
    return taskId;
  }

  async receiveReceipt(taskId: string, dto: ReceiptDto) {
    let advanceReleaseId: string | null = null;
    const result = await this.db.transaction(async (tx) => {
      const task = await tx.query<Row>('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
      if (!task.rows[0]) throw new NotFoundException(`Task ${taskId} not found`);
      const t = task.rows[0];

      const duplicate = await tx.query<Row>('SELECT * FROM node_receipts WHERE task_id = $1', [taskId]);
      if (duplicate.rows[0]) return duplicate.rows[0];

      const control = await tx.query<Row>(
        'SELECT * FROM node_controls WHERE node_id = $1 FOR UPDATE',
        [t.node_id],
      );
      const current = control.rows[0];
      const latestTask = await tx.query<{ id: string }>(
        `SELECT id FROM tasks
         WHERE node_id = $1 AND state IN ('dispatched', 'succeeded', 'failed')
           AND dispatched_at >= $2
         ORDER BY dispatched_at DESC, id DESC LIMIT 1`,
        [t.node_id, t.dispatched_at],
      );
      const accepted = Boolean(
        current &&
        current.release_id === t.release_id &&
        Number(current.generation) === Number(t.generation) &&
        latestTask.rows[0]?.id === t.id,
      );
      const rejectionReason = accepted
        ? ''
        : latestTask.rows[0]?.id && latestTask.rows[0].id !== t.id
          ? `Superseded within control generation by task ${latestTask.rows[0].id.slice(0, 8)} after restart`
          : current
            ? `Node now controlled by ${current.release_id} generation ${current.generation}`
            : 'Node has no active controlling release';

      await tx.query(
        `INSERT INTO node_receipts (task_id, release_id, node_id, generation, success, detail, accepted, rejection_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [t.id, t.release_id, t.node_id, t.generation, dto.success, dto.detail ?? '', accepted, rejectionReason],
      );
      await tx.query(
        `UPDATE tasks SET state = $1, finished_at = now(), error = $2 WHERE id = $3`,
        [accepted && dto.success ? 'succeeded' : accepted && !dto.success ? 'failed' : 'stale_receipt', dto.detail ?? '', t.id],
      );

      if (!accepted) {
        await this.audit(tx, t.release_id, 'late_receipt_ignored',
          `${t.node_id}: ${dto.success ? 'successful' : 'failed'} receipt audited but not applied (${rejectionReason})`);
        return { accepted: false, rejectionReason };
      }

      const release = await this.lockRelease(tx, t.release_id);
      if (!release) throw new NotFoundException(`Release ${t.release_id} not found`);
      const node = await this.getNodeForUpdate(tx, t.node_id);
      const rn = await tx.query<Row>(
        'SELECT * FROM release_nodes WHERE release_id = $1 AND node_id = $2 FOR UPDATE',
        [t.release_id, t.node_id],
      );
      const nodeRelease = rn.rows[0];
      const restore = nodeRelease?.state === 'restoring' || t.cert_id !== release.candidate_cert_id;

      if (dto.success) {
        await tx.query(
          `INSERT INTO node_cert_events (node_id, release_id, generation, task_id, from_cert_id, to_cert_id, kind)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [t.node_id, t.release_id, t.generation, t.id, node.current_cert_id, t.cert_id, restore ? 'restore' : 'switch'],
        );
        await tx.query('UPDATE nodes SET current_cert_id = $1 WHERE id = $2', [t.cert_id, t.node_id]);
        await tx.query(
          `UPDATE release_nodes SET state = $1, failure_reason = '', updated_at = now()
           WHERE release_id = $2 AND node_id = $3`,
          [restore ? 'restored' : 'succeeded', t.release_id, t.node_id],
        );
      } else {
        await tx.query(
          `UPDATE release_nodes SET state = 'failed', failure_reason = $1, updated_at = now()
           WHERE release_id = $2 AND node_id = $3`,
          [dto.detail ?? 'receipt failed', t.release_id, t.node_id],
        );
      }

      if (restore && !dto.success) {
        await tx.query(`UPDATE release_nodes SET state = 'restore_skipped', failure_reason = $1 WHERE release_id = $2 AND node_id = $3`,
          [dto.detail ?? 'restore failed', t.release_id, t.node_id]);
      }

      const all = await tx.query<Row>(
        'SELECT node_id, state FROM release_nodes WHERE release_id = $1',
        [t.release_id],
      );
      const receiptNodeState = dto.success ? (t.cert_id !== release.candidate_cert_id ? 'restored' : 'succeeded') : (t.cert_id !== release.candidate_cert_id ? 'restore_skipped' : 'failed');
      const currentIndex = all.rows.findIndex((row) => row.node_id === t.node_id);
      if (currentIndex >= 0) all.rows[currentIndex].state = receiptNodeState;
      const counts = this.countStates(all.rows);
      if (dto.success && !restore && release.state === 'running' && release.priority === 'normal') {
        const next = await tx.query<Row>(
          `SELECT node_id FROM release_nodes
           WHERE release_id = $1 AND state = 'pending'
           ORDER BY position LIMIT 1`,
          [release.id],
        );
        if (next.rows[0]) {
          await this.dispatchNode(tx, release.id, next.rows[0].node_id);
          all.rows.push({ node_id: next.rows[0].node_id, state: 'dispatched' });
        }
      }
      if (dto.success && !restore && release.priority === 'emergency') {
        const next = await tx.query<Row>(
          `SELECT node_id FROM release_nodes
           WHERE release_id = $1 AND state = 'pending'
           ORDER BY position LIMIT 1`,
          [release.id],
        );
        if (next.rows[0]) {
          await this.dispatchNode(tx, release.id, next.rows[0].node_id);
          const nextIndex = all.rows.findIndex((row) => row.node_id === next.rows[0].node_id);
          if (nextIndex >= 0) all.rows[nextIndex].state = 'dispatched';
        }
      }
      if (!dto.success && !restore && release.priority === 'emergency' && release.state === 'running') {
        advanceReleaseId = release.id;
      }
      const effectiveCounts = this.countStates(all.rows);
      if (release.state === 'cancelling' && !(effectiveCounts.pending > 0 || effectiveCounts.dispatched > 0 || effectiveCounts.restoring > 0)) {
        await this.finishCancel(tx, release, effectiveCounts);
      } else if (release.state === 'rolling_back' && !(effectiveCounts.pending > 0 || effectiveCounts.dispatched > 0 || effectiveCounts.restoring > 0)) {
        await tx.query(`UPDATE releases SET state = 'rolled_back', terminal_at = now() WHERE id = $1`, [release.id]);
        await tx.query('DELETE FROM node_controls WHERE release_id = $1', [release.id]);
        await this.audit(tx, release.id, 'rollback_finished', 'Successful nodes returned to previous certificate; failed nodes retain actual version');
      } else if (release.priority === 'normal' && release.state === 'waiting_canary' && dto.success) {
        await tx.query('UPDATE releases SET state = $1 WHERE id = $2', ['paused', release.id]);
        await this.audit(tx, release.id, 'canary_gate', `Canary ${t.node_id} installed; release pauses at gate`);
      } else if (!['waiting_canary', 'paused', 'cancelling'].includes(release.state)) {
        const recomputed = this.recomputeFinalState(effectiveCounts);
        if (recomputed) {
          await tx.query('UPDATE releases SET state = $1, terminal_at = now() WHERE id = $2', [recomputed, release.id]);
          if (recomputed === 'failed') await tx.query('DELETE FROM node_controls WHERE release_id = $1', [release.id]);
          await this.audit(tx, release.id, 'release_finished', `Final state ${recomputed}`);
        }
      }
      return { accepted: true };
    });

    if (advanceReleaseId) await this.advance(advanceReleaseId);
    return result;
  }

  async approveCanary(releaseId: string) {
    await this.db.transaction(async (tx) => {
      const release = await this.lockRelease(tx, releaseId);
      if (!release || release.priority !== 'normal' || release.state !== 'paused') {
        throw new ConflictException('Release is not paused at a canary gate');
      }
      await tx.query(`UPDATE releases SET state = 'running', canary_approved = true WHERE id = $1`, [releaseId]);
      const next = await tx.query<Row>(
        `SELECT node_id FROM release_nodes
         WHERE release_id = $1 AND state = 'pending'
         ORDER BY position LIMIT 1`,
        [releaseId],
      );
      if (next.rows[0]) {
        await this.dispatchNode(tx, releaseId, next.rows[0].node_id);
      }
      await this.audit(tx, releaseId, 'canary_approved', 'Operator approved rollout beyond canary');
    });
    return this.getRelease(this.db, releaseId);
  }

  async retryFailed(releaseId: string) {
    await this.db.transaction(async (tx) => {
      const release = await this.lockRelease(tx, releaseId);
      if (!release || !['running', 'partial_failed', 'failed'].includes(release.state)) throw new ConflictException('Release cannot retry');
      const failed = await tx.query<Row>(
        `SELECT rn.node_id FROM release_nodes rn
         WHERE rn.release_id = $1 AND rn.state = 'failed'
         ORDER BY rn.position FOR UPDATE`,
        [releaseId],
      );
      for (const node of failed.rows) {
        await tx.query(
          `UPDATE release_nodes SET state = 'pending', failure_reason = '', updated_at = now()
           WHERE release_id = $1 AND node_id = $2`,
          [releaseId, node.node_id],
        );
        await this.dispatchNode(tx, releaseId, node.node_id);
      }
      await tx.query(`UPDATE releases SET state = 'running', terminal_at = NULL WHERE id = $1`, [releaseId]);
      await this.audit(tx, releaseId, 'retry_failed', `${failed.rows.length} failed node(s) queued for retry`);
    });
    return this.getRelease(this.db, releaseId);
  }

  async rollbackNormal(releaseId: string) {
    await this.db.transaction(async (tx) => {
      const release = await this.lockRelease(tx, releaseId);
      if (!release || release.priority !== 'normal') throw new ConflictException('Only normal releases use explicit rollback');
      if (!['paused', 'partial_failed', 'failed', 'succeeded', 'running'].includes(release.state)) throw new ConflictException('Release is not rollback eligible');
      await tx.query(`UPDATE releases SET state = 'rolling_back' WHERE id = $1`, [releaseId]);
      const succeeded = await tx.query<Row>(
        `SELECT rn.* FROM release_nodes rn WHERE rn.release_id = $1 AND rn.state = 'succeeded'
         ORDER BY rn.position DESC FOR UPDATE`,
        [releaseId],
      );
      for (const rn of succeeded.rows) {
        await tx.query(`UPDATE release_nodes SET state = 'restoring' WHERE release_id = $1 AND node_id = $2`, [releaseId, rn.node_id]);
        await this.dispatchRestore(tx, releaseId, rn.node_id);
      }
      await this.audit(tx, releaseId, 'rollback_started', `${succeeded.rows.length} successful node(s) restoring previous certificate`);
    });
    return this.getRelease(this.db, releaseId);
  }

  async cancelEmergency(releaseId: string) {
    await this.db.transaction(async (tx) => {
      const release = await this.lockRelease(tx, releaseId);
      if (!release || release.priority !== 'emergency') throw new ConflictException('Only emergency releases can be cancelled this way');
      if (!['running', 'partial_failed', 'failed', 'succeeded'].includes(release.state)) throw new ConflictException('Emergency release is not cancellable');

      await tx.query(`UPDATE releases SET state = 'cancelling' WHERE id = $1`, [releaseId]);
      const successful = await tx.query<Row>(
        `SELECT rn.*, c.domain AS cert_domain
         FROM release_nodes rn JOIN certificates c ON c.id = rn.previous_cert_id
         WHERE rn.release_id = $1 AND rn.state = 'succeeded' AND c.domain = $2
         ORDER BY rn.position DESC FOR UPDATE`,
        [releaseId, release.domain],
      );
      for (const rn of successful.rows) {
        await tx.query(`UPDATE release_nodes SET state = 'restoring' WHERE release_id = $1 AND node_id = $2`, [releaseId, rn.node_id]);
        await this.dispatchRestore(tx, releaseId, rn.node_id);
      }

      const all = await tx.query<Row>('SELECT state FROM release_nodes WHERE release_id = $1', [releaseId]);
      const counts = this.countStates(all.rows);
      if (counts.restoring === 0 && counts.dispatched === 0) {
        await this.finishCancel(tx, release, counts);
      }
      await this.audit(tx, releaseId, 'emergency_cancel_started', 'Successful nodes restore matching pre-takeover certificate; failed nodes retain actual version');
    });
    return this.getRelease(this.db, releaseId);
  }

  private async finishCancel(tx: DbClient, release: Row, counts: Record<string, number>) {
    const hasFailure = counts.failed > 0 || counts.restore_skipped > 0;
    const state = hasFailure ? 'cancel_partial' : 'cancelled';
    await tx.query(`UPDATE releases SET state = $1, terminal_at = now() WHERE id = $2`, [state, release.id]);
    await tx.query('DELETE FROM node_controls WHERE release_id = $1', [release.id]);
    await this.audit(tx, release.id, hasFailure ? 'emergency_cancel_partial' : 'emergency_cancelled',
      hasFailure ? 'Cancelled; failed node audit retained and old normal release is not resumed' : 'Cancelled; all restored nodes no longer controlled');
  }

  private recomputeFinalState(counts: Record<string, number>): string | null {
    if (counts.pending > 0 || counts.dispatched > 0 || counts.restoring > 0) return null;
    if ((counts.failed ?? 0) === 0 && (counts.restore_skipped ?? 0) === 0) return 'succeeded';
    if ((counts.succeeded ?? 0) > 0 || (counts.restored ?? 0) > 0) return 'partial_failed';
    return 'failed';
  }

  private async finishRelease(tx: DbClient, release: Row, counts: Record<string, number>) {
    const state = this.recomputeFinalState(counts);
    if (!state || state === release.state) return;

    if (release.priority === 'normal' && state === 'failed') {
      await tx.query('DELETE FROM node_controls WHERE release_id = $1', [release.id]);
    }
    await tx.query('UPDATE releases SET state = $1, terminal_at = now() WHERE id = $2', [state, release.id]);
    await this.audit(tx, release.id, 'release_finished', `Final state ${state}`);
  }

  private async refreshOldReleaseAfterTakeover(tx: DbClient, oldReleaseId: string) {
    const release = await this.lockRelease(tx, oldReleaseId);
    const rows = await tx.query<Row>('SELECT state FROM release_nodes WHERE release_id = $1', [oldReleaseId]);
    const counts = this.countStates(rows.rows);
    const activeCount = counts.pending + counts.dispatched;
    if (activeCount === 0) {
      await tx.query(`UPDATE releases SET state = 'superseded', terminal_at = now()
                      WHERE id = $1 AND state IN ('waiting_canary', 'paused', 'running')`, [oldReleaseId]);
      await tx.query('DELETE FROM node_controls WHERE release_id = $1', [oldReleaseId]);
    }
    await this.audit(
      tx,
      oldReleaseId,
      activeCount === 0 ? 'release_superseded' : 'release_nodes_superseded',
      `Emergency takeover changed ${counts.superseded} node(s); successful nodes and switch records retained`,
    );
  }

  async listReleases() {
    const rows = await this.db.query<Row>(
      `SELECT r.*, c.version AS cert_version, c.domain,
              (SELECT count(*) FROM release_nodes rn WHERE rn.release_id = r.id)::int AS node_count
       FROM releases r JOIN certificates c ON c.id = r.candidate_cert_id
       ORDER BY r.created_at DESC, r.id DESC`,
    );
    return rows.rows;
  }

  async getRelease(client: DbClient, releaseId: string): Promise<Row> {
    const rows = await client.query<Row>(
      `SELECT r.*, c.version AS cert_version,
              (SELECT count(*) FROM release_nodes rn WHERE rn.release_id = r.id)::int AS node_count
       FROM releases r JOIN certificates c ON c.id = r.candidate_cert_id
       WHERE r.id = $1`,
      [releaseId],
    );
    if (!rows.rows[0]) throw new NotFoundException(`Release ${releaseId} not found`);
    return rows.rows[0];
  }

  async getReleaseDetails(releaseId: string) {
    const release = await this.getRelease(this.db, releaseId);
    const nodes = await this.db.query<Row>(
      `SELECT rn.*, n.name AS node_name, n.current_cert_id, c.version AS current_cert_version,
              pc.version AS previous_cert_version
       FROM release_nodes rn
       JOIN nodes n ON n.id = rn.node_id
       LEFT JOIN certificates c ON c.id = n.current_cert_id
       LEFT JOIN certificates pc ON pc.id = rn.previous_cert_id
       WHERE rn.release_id = $1 ORDER BY rn.position`,
      [releaseId],
    );
    const supersessions = await this.db.query<Row>(
      `SELECT s.*, er.reason AS emergency_reason, c.version AS previous_cert_version
       FROM release_supersessions s
       JOIN releases er ON er.id = s.emergency_release_id
       LEFT JOIN certificates c ON c.id = s.previous_cert_id
       WHERE s.emergency_release_id = $1 OR s.superseded_release_id = $1
       ORDER BY s.created_at`,
      [releaseId],
    );
    const receipts = await this.db.query<Row>(
      `SELECT rc.*, t.attempt FROM node_receipts rc JOIN tasks t ON t.id = rc.task_id
       WHERE rc.release_id = $1 ORDER BY rc.received_at`,
      [releaseId],
    );
    const audit = await this.db.query<Row>(
      'SELECT * FROM release_audit WHERE release_id = $1 ORDER BY id',
      [releaseId],
    );
    return { release, nodes: nodes.rows, supersessions: supersessions.rows, receipts: receipts.rows, audit: audit.rows };
  }

  async snapshot() {
    const nodes = await this.db.query<Row>(
      `SELECT n.*, c.version AS current_cert_version,
              nc.release_id AS controlling_release_id, nc.generation AS control_generation
       FROM nodes n LEFT JOIN certificates c ON c.id = n.current_cert_id
       LEFT JOIN node_controls nc ON nc.node_id = n.id
       ORDER BY n.id`,
    );
    const events = await this.db.query<Row>(
      `SELECT e.*, fc.version AS from_version, tc.version AS to_version
       FROM node_cert_events e
       LEFT JOIN certificates fc ON fc.id = e.from_cert_id
       LEFT JOIN certificates tc ON tc.id = e.to_cert_id
       ORDER BY e.id DESC LIMIT 50`,
    );
    const lateReceipts = await this.db.query<Row>(
      `SELECT rc.*, r.priority FROM node_receipts rc JOIN releases r ON r.id = rc.release_id
       WHERE rc.accepted = false ORDER BY rc.received_at DESC LIMIT 50`,
    );
    return { nodes: nodes.rows, events: events.rows, lateReceipts: lateReceipts.rows, releases: await this.listReleases() };
  }

  async setNodeBehavior(nodeId: string, behavior: 'succeed' | 'fail' | 'late_success') {
    await this.db.query('UPDATE nodes SET behavior = $1 WHERE id = $2', [behavior, nodeId]);
    return this.snapshot();
  }

  private async lockNodes(tx: DbClient, nodeIds: string[]) {
    return tx.query('SELECT id FROM nodes WHERE id = ANY($1) ORDER BY id FOR UPDATE', [nodeIds]);
  }

  private async getNodeForUpdate(tx: DbClient, nodeId: string): Promise<Row> {
    const node = await tx.query<Row>('SELECT * FROM nodes WHERE id = $1 FOR UPDATE', [nodeId]);
    if (!node.rows[0]) throw new NotFoundException(`Node ${nodeId} not found`);
    return node.rows[0];
  }

  private async lockRelease(tx: DbClient, releaseId: string): Promise<Row | null> {
    const release = await tx.query<Row>('SELECT * FROM releases WHERE id = $1 FOR UPDATE', [releaseId]);
    return release.rows[0] ?? null;
  }

  private countStates(rows: Row[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
    return counts;
  }

  private async audit(tx: DbClient, releaseId: string, event: string, detail = '', actor = 'system') {
    await tx.query(
      'INSERT INTO release_audit (release_id, event, detail, actor) VALUES ($1, $2, $3, $4)',
      [releaseId, event, detail, actor],
    );
  }
}
