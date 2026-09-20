export interface QueryParams {
  [key: string]: unknown;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
}

export interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: QueryParams | unknown[]): Promise<QueryResult<T>>;
}

export abstract class DbExecutor implements DbClient {
  abstract query<T = Record<string, unknown>>(sql: string, params?: QueryParams | unknown[]): Promise<QueryResult<T>>;
  abstract transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T>;
  abstract close(): Promise<void>;
}
