import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { EngineService } from './engine.service';

export interface ReceiptDto {
  requestId: string;
  outcome: 'success' | 'failure';
  certVersion?: number | null;
  error?: string;
}

/**
 * Receipt intake. A receipt is only applied when its request is still
 * in-flight AND its (release, epoch) still controls the node. Everything
 * else — timed-out requests, superseded control, duplicates — is audited
 * as a late receipt without touching the node's actual cert, the task
 * state, or the gray gate.
 */
@Injectable()
export class ReceiptsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly engine: EngineService,
  ) {}

  async handleReceipt(dto: ReceiptDto) {
    if (!dto.requestId) return { accepted: false, reason: 'requestId required' };
    let releaseId: string | null = null;
    const receipt = await this.dataSource.transaction(async (em) => {
      const reqs = await em.query(`SELECT * FROM dispatch_requests WHERE id = $1 FOR UPDATE`, [dto.requestId]);
      const req = reqs[0];
      if (!req) {
        return this.insertReceipt(em, dto, null, false, true, 'unknown request');
      }
      releaseId = req.release_id;

      if (req.status !== 'in_flight') {
        // timed out / orphaned / already completed: audit only, never re-apply
        return this.insertReceipt(em, dto, req, false, true, `request already ${req.status}`);
      }
      const ctls = await em.query(`SELECT * FROM node_control WHERE node_id = $1 FOR UPDATE`, [req.node_id]);
      const ctl = ctls[0];
      if (!ctl || ctl.release_id !== req.release_id || ctl.epoch !== req.epoch) {
        await em.query(
          `UPDATE dispatch_requests SET status = 'orphaned', completed_at = now() WHERE id = $1`,
          [req.id],
        );
        return this.insertReceipt(
          em,
          dto,
          req,
          false,
          true,
          `control superseded (epoch ${req.epoch} -> ${ctl?.epoch ?? 'none'}); receipt audited only`,
        );
      }

      // authoritative receipt: apply it
      await em.query(
        `UPDATE dispatch_requests SET status = 'completed', outcome = $2, completed_at = now() WHERE id = $1`,
        [req.id, dto.outcome],
      );
      if (dto.outcome === 'success') {
        await em.query(
          `UPDATE nodes
             SET current_cert_id = $2, current_cert_version = $3,
                 cert_updated_by_release_id = $4, cert_updated_at = now()
           WHERE id = $1`,
          [req.node_id, req.cert_id, dto.certVersion ?? null, req.release_id],
        );
        const taskStatus = req.kind === 'deploy' ? 'success' : 'rolled_back';
        await em.query(
          `UPDATE release_tasks SET status = $2, updated_at = now() WHERE id = $1 AND status IN ('in_flight','restoring')`,
          [req.task_id, taskStatus],
        );
        return this.insertReceipt(em, dto, req, true, false, `${req.kind} applied`);
      }
      await em.query(
        `UPDATE release_tasks SET status = 'failed', last_error = $2, updated_at = now()
         WHERE id = $1 AND status IN ('in_flight','restoring')`,
        [req.task_id, dto.error || 'node reported failure'],
      );
      return this.insertReceipt(em, dto, req, true, false, 'failure recorded on task');
    });
    if (releaseId) await this.engine.maybeAdvance(releaseId);
    return { accepted: true, receipt };
  }

  private async insertReceipt(
    em: EntityManager,
    dto: ReceiptDto,
    req: any,
    applied: boolean,
    late: boolean,
    note: string,
  ) {
    const rows = await em.query(
      `INSERT INTO receipts (request_id, release_id, node_id, epoch, outcome, applied, late, note, cert_version, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        dto.requestId,
        req?.release_id ?? null,
        req?.node_id ?? null,
        req?.epoch ?? null,
        dto.outcome,
        applied,
        late,
        note,
        dto.certVersion ?? null,
        JSON.stringify(dto),
      ],
    );
    return rows[0];
  }

  async listReceipts(query: any) {
    const cond: string[] = [];
    const params: any[] = [];
    if (query.nodeId) {
      params.push(query.nodeId);
      cond.push(`rc.node_id = $${params.length}`);
    }
    if (query.releaseId) {
      params.push(query.releaseId);
      cond.push(`rc.release_id = $${params.length}`);
    }
    if (query.late === 'true') cond.push(`rc.late = true`);
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    return this.dataSource.query(
      `SELECT rc.*, n.name AS node_name, r.name AS release_name
         FROM receipts rc
         LEFT JOIN nodes n ON n.id = rc.node_id
         LEFT JOIN releases r ON r.id = rc.release_id
        ${where}
        ORDER BY rc.received_at DESC LIMIT 500`,
      params,
    );
  }
}
