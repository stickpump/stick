import { Pool, type QueryResultRow } from "pg";

type GlobalWithPg = typeof globalThis & {
  __stickPgPool?: Pool;
};

const globalForPg = globalThis as GlobalWithPg;

export function hasDatabaseUrl() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured.");
  }

  if (!globalForPg.__stickPgPool) {
    globalForPg.__stickPgPool = new Pool({
      connectionString,
      max: Number(process.env.PGPOOL_MAX ?? 10),
      idleTimeoutMillis: 30_000
    });
  }

  return globalForPg.__stickPgPool;
}

export async function dbQuery<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
  return getPool().query<T>(text, params);
}
