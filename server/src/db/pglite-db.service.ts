import { PGlite } from '@electric-sql/pglite';
import { DbClient, DbExecutor, QueryParams, QueryResult } from './types.js';
import { schemaSql } from './schema.js';

export class PgliteDbService implements DbExecutor {
  constructor(public readonly pglite: PGlite) {}

  static async create(): Promise<PgliteDbService> {
    const pglite = new PGlite();
    await pglite.exec(schemaSql);
    return new PgliteDbService(pglite);
  }

  async query<T = Record<string, unknown>>(sql: string, params: QueryParams | unknown[] = []): Promise<QueryResult<T>> {
    return this.pglite.query<T>(sql, Array.isArray(params) ? params : Object.values(params));
  }

  async transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.pglite.transaction(async (pgliteTx) => {
      const tx: DbClient = {
        query: async (sql, params = []) => pgliteTx.query(sql, Array.isArray(params) ? params : Object.values(params)),
      };
      return work(tx);
    });
  }

  async close(): Promise<void> {
    await this.pglite.close();
  }
}
