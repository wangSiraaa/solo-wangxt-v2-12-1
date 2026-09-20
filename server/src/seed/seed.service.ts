import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DbExecutor } from '../db/types.js';

@Injectable()
export class SeedService {
  constructor(private readonly db: DbExecutor) {}

  async seedIfEmpty(): Promise<void> {
    const { rows } = await this.db.query<{ count: string }>('SELECT count(*)::text AS count FROM nodes');
    if (Number(rows[0]?.count ?? 0) > 0) return;

    const domain = 'payments.example.internal';
    const certs = [
      ['cert-old-1', '2024-01'],
      ['cert-old-2', '2024-07'],
      ['cert-rotation', '2026-rot'],
      ['cert-emergency', '2026-emergency'],
    ] as const;

    for (const [id, version] of certs) {
      await this.db.query(
        `INSERT INTO certificates (id, domain, version, fingerprint)
         VALUES ($1, $2, $3, $4)`,
        [id, domain, version, `sha256:${id}-${version}`],
      );
    }

    const nodes = [
      ['node-a', 'Payments A', 'succeed', 'cert-old-1'],
      ['node-b', 'Payments B', 'succeed', 'cert-old-1'],
      ['node-c', 'Payments C', 'fail', 'cert-old-2'],
      ['node-d', 'Payments D', 'succeed', 'cert-old-2'],
    ] as const;

    for (const [id, name, behavior, certId] of nodes) {
      await this.db.query(
        `INSERT INTO nodes (id, name, domain, current_cert_id, behavior)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, name, domain, certId, behavior],
      );
    }
  }

  async resetForDemo(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('TRUNCATE release_audit, release_supersessions, node_receipts, node_cert_events, tasks, node_controls, release_nodes, releases, nodes, certificates RESTART IDENTITY CASCADE');
    });
    await this.seedIfEmpty();
  }

  async ensureCertificate(domain: string, version: string): Promise<{ id: string }> {
    const id = version.startsWith('cert-') ? version : `cert-${version}-${randomUUID().slice(0, 8)}`;
    await this.db.query(
      `INSERT INTO certificates (id, domain, version, fingerprint)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET domain = EXCLUDED.domain, version = EXCLUDED.version, fingerprint = EXCLUDED.fingerprint`,
      [id, domain, version, `sha256:${id}-${version}`],
    );
    return { id };
  }
}
