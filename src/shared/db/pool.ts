import { Pool } from "pg";
import { loadEnv } from "../../config/env";

export interface Db {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
}

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const env = loadEnv();
    pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
  }
  return pool;
}
