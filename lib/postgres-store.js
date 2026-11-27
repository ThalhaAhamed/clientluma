import pg from "pg";
import { parseDatabaseUrl } from "./settings.js";

function createPool(url) {
  const config = parseDatabaseUrl(url);
  if (!config) throw new Error("Enter a valid PostgreSQL connection URL.");
  const pool = new pg.Pool({ ...config, max: 5, connectionTimeoutMillis: 5000, query_timeout: 8000,
    application_name: "cuelensa" });
  pool.on("error", error => console.error("A PostgreSQL connection closed.", error.code || ""));
  return pool;
}

export async function testPostgres(url) {
  const pool = createPool(url);
  try { await pool.query("SELECT 1"); }
  finally { await pool.end(); }
}

export async function openPostgres(url) {
  const pool = createPool(url);
  try {
    await pool.query(`
      BEGIN;
      SELECT pg_advisory_xact_lock(1981751027);
      CREATE SCHEMA IF NOT EXISTS cuelensa;
      CREATE TABLE IF NOT EXISTS cuelensa.clients (
        id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cuelensa.meetings (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, started_at TEXT NOT NULL, record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS meetings_client_date ON cuelensa.meetings (client_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS meetings_date ON cuelensa.meetings (started_at DESC);
      COMMIT;
    `);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const prepare = (sql, connection = pool) => {
    let parameter = 0;
    const statement = sql.replace(/\b(clients|meetings)\b/g, "cuelensa.$1").replace(/\?/g, () => `$${++parameter}`);
    return {
      all: async (...args) => (await execute(connection, statement, args)).rows,
      get: async (...args) => (await execute(connection, statement, args)).rows[0],
      run: (...args) => execute(connection, statement, args),
    };
  };
  return {
    prepare,
    async writeBatch(commands) {
      const connection = await pool.connect().catch(() => { throw new Error("The workspace database is unavailable."); });
      try {
        await execute(connection, "BEGIN");
        for (const [sql, args] of commands) await prepare(sql, connection).run(...args);
        await execute(connection, "COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { connection.release(); }
    },
  };
}

async function execute(connection, sql, args) {
  try { return await connection.query(sql, args); }
  catch (error) {
    console.error("PostgreSQL workspace query failed.", error.code || "");
    throw new Error("The workspace database operation failed.");
  }
}
