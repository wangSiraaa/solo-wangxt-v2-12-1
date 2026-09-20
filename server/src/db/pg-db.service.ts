import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DbClient, DbExecutor, QueryResult } from './types.js';
import { schemaSql } from './schema.js';

export const DB_OPTIONS = 'DB_OPTIONS';

export interface DbOptions {
  connectionString?: string;
}

class PgTransaction implements DbClient {
  constructor(private readonly client: PoolClient) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.client.query(sql, params) as unknown as Promise<QueryResult<T>>;
  }
}

@Injectable()
export class PgDbService implements DbExecutor, OnModuleInit, OnModuleDestroy {
  private pool: Pool;

  constructor(@Optional() @Inject(DB_OPTIONS) options: DbOptions = {}) {
    this.pool = new Pool({
      connectionString:
        options.connectionString ?? process.env.DATABASE_URL ?? 'postgres://localhost:5432/cert_takeover',
      max: 10,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.query(schemaSql);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query(sql, params) as unknown as Promise<QueryResult<T>>;
  }

  async transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new PgTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
