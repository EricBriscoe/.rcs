import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function privateDirectory(path: string) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw Error("Efficiency state must not be a symlink.");
  mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700);
}
function database<T>(agent: string, fn: (db: DatabaseSync) => T): T | undefined {
  let db: DatabaseSync | undefined;
  try {
    const dir = join(agent, "efficiency"); privateDirectory(dir);
    const path = join(dir, "usage.sqlite");
    for (const file of [path, path + "-wal", path + "-shm"]) {
      try { if (lstatSync(file).isSymbolicLink()) return; }
      catch (error: any) { if (error.code !== "ENOENT") throw error; }
    }
    db = new DatabaseSync(path); chmodSync(path, 0o600);
    db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,session TEXT,category TEXT,model TEXT,at INTEGER,input INTEGER,output INTEGER,cache_read INTEGER,cache_write INTEGER,total INTEGER,cost REAL);
      CREATE INDEX IF NOT EXISTS usage_session ON usage(session);
      CREATE TABLE IF NOT EXISTS output(id TEXT PRIMARY KEY,session TEXT,filter TEXT,at INTEGER,before_bytes INTEGER,after_bytes INTEGER);
      CREATE INDEX IF NOT EXISTS output_session ON output(session);`);
    return fn(db);
  } catch { return; } // Telemetry must never fail a task; /tokens reports unavailable storage.
  finally { try { db?.close(); } catch { /* Best-effort accounting, including shutdown. */ } }
}
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
export function recordUsage(agent: string, session: string, category: string, model: string, usage: any, id: string = randomUUID()): void {
  if (!usage) return;
  database(agent, db => db.prepare("INSERT OR IGNORE INTO usage VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
    id, session, category, model, Date.now(), count(usage.input), count(usage.output), count(usage.cacheRead), count(usage.cacheWrite),
    count(usage.totalTokens ?? (count(usage.input) + count(usage.output) + count(usage.cacheRead) + count(usage.cacheWrite))), count(usage.cost?.total),
  ));
}
export function recordOutput(agent: string, session: string, filter: string, before: number, after: number): void {
  database(agent, db => db.prepare("INSERT INTO output VALUES(?,?,?,?,?,?)").run(randomUUID(), session, filter, Date.now(), before, after));
}
export function usageReport(agent: string, session?: string) {
  return database(agent, db => {
    const where = session ? " WHERE session=?" : "", params = session ? [session] : [];
    return {
      models: db.prepare(`SELECT category,model,count(*) AS calls,sum(input) AS input,sum(cache_read) AS cacheRead,sum(cache_write) AS cacheWrite,sum(output) AS output,sum(total) AS total,sum(cost) AS cost FROM usage${where} GROUP BY category,model ORDER BY category,model`).all(...params),
      output: db.prepare(`SELECT filter,count(*) AS calls,sum(before_bytes) AS beforeBytes,sum(after_bytes) AS afterBytes FROM output${where} GROUP BY filter ORDER BY filter`).all(...params),
    };
  });
}
export function formatReport(report: ReturnType<typeof usageReport>) {
  if (!report) return "Usage storage unavailable; task execution is unaffected.";
  const lines = ["Provider-reported tokens since instrumentation was installed (no history import):", "category/model: calls | input | cache read/write | output | total"];
  for (const r of report.models) lines.push(`${r.category}/${r.model}: ${r.calls} | ${r.input} | ${r.cacheRead}/${r.cacheWrite} | ${r.output} | ${r.total}`);
  if (!report.models.length) lines.push("No reported model usage yet.");
  lines.push("", "Tool-result bytes before → after (not provider-token or billing savings):");
  for (const r of report.output) lines.push(`${r.filter}: ${r.calls} calls | ${r.beforeBytes} → ${r.afterBytes}`);
  lines.push("Output includes reasoning where reported by the provider. Failed calls without usage are not measurable. Sessions are counted independently; use Pi's /session or the subagent fleet for delegated usage.");
  return lines.join("\n");
}
