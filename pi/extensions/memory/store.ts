import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GLOBAL_SCOPE, hash, KINDS, safeText, searchTerms, topicKey } from "./policy.ts";
import type { Candidate, Payload } from "./policy.ts";

export class MemoryStore {
  db: DatabaseSync;
  now: () => number;
  closed = false;

  constructor(path: string, now = Date.now) {
    this.now = now;
    const dir = dirname(path);
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error("Memory directory must not be a symlink.");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Memory database must not be a symlink.");
    this.db = new DatabaseSync(path);
    try {
      this.db.function("memory_fingerprint", { deterministic: true }, (text) => fingerprint(String(text)));
      chmodSync(path, 0o600);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;");
      this.transaction(() => {
        const version = this.db.prepare("PRAGMA user_version").get()!.user_version;
        if (![0, 1, 2].includes(Number(version))) throw new Error("Unsupported memory database version.");
        if (version === 1) {
          // Only the disposable index changes; canonical notes and tombstones stay.
          this.db.exec("DROP TRIGGER IF EXISTS memory_insert; DROP TRIGGER IF EXISTS memory_update; DROP TRIGGER IF EXISTS memory_delete; DROP TABLE IF EXISTS memory_fts;");
        }
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS controls(scope TEXT PRIMARY KEY, reading INTEGER NOT NULL DEFAULT 1, learning INTEGER NOT NULL DEFAULT 1, generation INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS memories(
            id TEXT PRIMARY KEY, scope TEXT NOT NULL, topic TEXT NOT NULL, kind TEXT NOT NULL,
            text TEXT NOT NULL, keywords TEXT NOT NULL, sources TEXT NOT NULL,
            manual INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, evidence_at INTEGER NOT NULL, evidence_order INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
            UNIQUE(scope, topic));
          CREATE TABLE IF NOT EXISTS versions(
            memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL, text TEXT NOT NULL, sources TEXT NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(memory_id, revision));
          CREATE TABLE IF NOT EXISTS revoked(scope TEXT NOT NULL, topic TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(scope, topic, fingerprint));
          CREATE TABLE IF NOT EXISTS jobs(
            id TEXT PRIMARY KEY, scope TEXT NOT NULL, session TEXT NOT NULL, payload TEXT,
            generation INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
            ready_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, owner TEXT,
            created_at INTEGER NOT NULL, finished_at INTEGER, error TEXT, tokens INTEGER NOT NULL DEFAULT 0);
          CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(scope, state, ready_at);
          CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope, updated_at);
          CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(topic, keywords, text, content='memories', content_rowid='rowid', tokenize='porter unicode61');
          CREATE TRIGGER IF NOT EXISTS memory_insert AFTER INSERT ON memories BEGIN
            INSERT INTO memory_fts(rowid, topic, keywords, text) VALUES(new.rowid, new.topic, new.keywords, new.text);
          END;
          CREATE TRIGGER IF NOT EXISTS memory_delete AFTER DELETE ON memories BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, topic, keywords, text) VALUES('delete', old.rowid, old.topic, old.keywords, old.text);
          END;
          CREATE TRIGGER IF NOT EXISTS memory_update AFTER UPDATE ON memories BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, topic, keywords, text) VALUES('delete', old.rowid, old.topic, old.keywords, old.text);
            INSERT INTO memory_fts(rowid, topic, keywords, text) VALUES(new.rowid, new.topic, new.keywords, new.text);
          END;
          PRAGMA user_version=2;
        `);
        if (version === 1) this.db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild');");
      });
    } catch (error) { this.db.close(); throw error; }
  }

  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  control(scope: string): any {
    return this.db.prepare("SELECT * FROM controls WHERE scope=?").get(scope) ?? { reading: 1, learning: 1, generation: 0 };
  }

  generation(scope: string): string {
    return `${this.control(scope).generation}:${this.control(GLOBAL_SCOPE).generation}`;
  }

  setControl(scope: string, field: "reading" | "learning", enabled: boolean) {
    if (!["reading", "learning"].includes(field)) throw new Error("Invalid memory control.");
    this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO controls(scope) VALUES(?)").run(scope);
      const previous = this.control(scope)[field];
      this.db.prepare(`UPDATE controls SET ${field}=? WHERE scope=?`).run(Number(enabled), scope);
      // Re-enabling also fences evidence accumulated in another instance while
      // learning was off; those entries must not become a retrospective import.
      if (field === "learning" && previous !== Number(enabled)) this.invalidateJobs(scope);
    });
  }

  invalidateJobs(scope: string) {
    this.db.prepare("INSERT OR IGNORE INTO controls(scope) VALUES(?)").run(scope);
    this.db.prepare("UPDATE controls SET generation=generation+1 WHERE scope=?").run(scope);
    this.db.prepare("UPDATE jobs SET state='cancelled', payload=NULL, owner=NULL, error=NULL, finished_at=? WHERE scope=? AND state IN ('pending','running','failed')").run(this.now(), scope);
  }

  decode(row: any) { return row ? { ...row, sources: JSON.parse(row.sources) } : undefined; }

  get(scope: string, id: string, history = false): any {
    const row = this.decode(this.db.prepare("SELECT * FROM memories WHERE id=? AND scope IN (?,?)").get(id, scope, GLOBAL_SCOPE));
    if (!row) throw new Error("Memory not found in the current scope.");
    if (history) row.history = this.db.prepare("SELECT revision,text,sources,updated_at FROM versions WHERE memory_id=? ORDER BY revision DESC LIMIT 10").all(id)
      .map((version: any) => ({ ...version, sources: JSON.parse(version.sources) }));
    return row;
  }

  list(scope: string, limit = 30): any[] {
    return this.db.prepare("SELECT * FROM memories WHERE scope IN (?,?) ORDER BY pinned DESC,updated_at DESC LIMIT ?")
      .all(scope, GLOBAL_SCOPE, Math.min(100, Math.max(1, limit))).map((row) => this.decode(row));
  }

  search(scope: string, query: string, limit = 8): any[] {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const match = terms.map((term) => `"${term}"`).join(" OR ");
    return this.db.prepare(`SELECT m.* FROM memory_fts JOIN memories m ON m.rowid=memory_fts.rowid
      WHERE memory_fts MATCH ? AND m.scope IN (?,?) ORDER BY bm25(memory_fts,8,4,1),m.updated_at DESC LIMIT ?`)
      .all(match, scope, GLOBAL_SCOPE, Math.min(30, Math.max(1, limit))).map((row) => this.decode(row));
  }

  recall(scope: string, query: string): any[] {
    if (!this.control(scope).reading) return [];
    const pinned = this.db.prepare("SELECT * FROM memories WHERE scope IN (?,?) AND pinned=1 ORDER BY updated_at DESC LIMIT 4")
      .all(scope, GLOBAL_SCOPE).map((row) => this.decode(row));
    return [...new Map([...pinned, ...this.search(scope, query)].map((row) => [row.id, row])).values()].slice(0, 8);
  }

  blocked(scope: string): string[] {
    return this.db.prepare("SELECT DISTINCT topic FROM revoked WHERE scope IN (?,?)").all(scope, GLOBAL_SCOPE).map((row: any) => row.topic);
  }

  save(scope: string, candidate: Candidate, { manual = false, pinned = false, restore = false } = {}): any {
    return this.transaction(() => this.saveInside(scope, candidate, { manual, pinned, restore }));
  }

  saveInside(scope: string, candidate: Candidate, { manual = false, pinned = false, restore = false, evidenceAt = this.now(), evidenceOrder = 0 } = {}): any {
    const topic = topicKey(candidate.topic);
    const text = safeText(candidate.text, 1600, "Memory text");
    const keywords = candidate.keywords ? safeText(candidate.keywords, 600, "Keywords") : "";
    if (!KINDS.includes(candidate.kind)) throw new Error("Invalid memory kind.");
    if (scope === GLOBAL_SCOPE && !manual) throw new Error("Global memory requires an explicit user command.");
    const digest = fingerprint(text);
    if (restore && manual) this.db.prepare("DELETE FROM revoked WHERE scope=? AND (topic=? OR fingerprint=?)").run(scope, topic, digest);
    if (this.db.prepare("SELECT 1 FROM revoked WHERE scope IN (?,?) AND (topic=? OR fingerprint=?)").get(scope, GLOBAL_SCOPE, topic, digest)) return { skipped: "revoked", topic };
    const existing: any = this.db.prepare("SELECT * FROM memories WHERE scope=? AND topic=?").get(scope, topic);
    if (existing?.manual && !manual) return { skipped: "manual", topic };
    if (existing && !manual && (existing.evidence_at > evidenceAt || (existing.evidence_at === evidenceAt && existing.evidence_order > evidenceOrder))) return { skipped: "stale", topic };
    const duplicate: any = this.db.prepare("SELECT id FROM memories WHERE scope=? AND lower(text)=lower(?) AND topic<>?").get(scope, text, topic);
    if (duplicate) return { skipped: "duplicate", id: duplicate.id, topic };
    const id = existing?.id ?? randomUUID();
    const sources = JSON.stringify(candidate.sources ?? []);
    if (sources.length > 6000 || redactSources(sources)) throw new Error("Invalid memory evidence.");
    if (existing && existing.text !== text) {
      this.db.prepare("INSERT INTO versions(memory_id,revision,text,sources,updated_at) VALUES(?,?,?,?,?)")
        .run(id, existing.revision, existing.text, existing.sources, existing.updated_at);
    }
    this.db.prepare(`INSERT INTO memories(id,scope,topic,kind,text,keywords,sources,manual,pinned,created_at,updated_at,evidence_at,evidence_order)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,topic) DO UPDATE SET kind=excluded.kind,text=excluded.text,
      keywords=excluded.keywords,sources=excluded.sources,manual=excluded.manual,
      pinned=CASE WHEN excluded.manual=1 THEN excluded.pinned ELSE memories.pinned END,
      updated_at=excluded.updated_at,evidence_at=excluded.evidence_at,evidence_order=excluded.evidence_order,revision=memories.revision+1`)
      .run(id, scope, topic, candidate.kind, text, keywords, sources, Number(manual), Number(pinned), this.now(), this.now(), evidenceAt, evidenceOrder);
    return this.get(scope, id);
  }

  pin(scope: string, id: string, pinned: boolean) {
    const memory = this.get(scope, id);
    if (memory.scope !== scope) throw new Error("Use the global command for global memories.");
    this.db.prepare("UPDATE memories SET pinned=? WHERE id=? AND scope=?").run(Number(pinned), id, scope);
    return this.get(scope, id);
  }

  eraseInside(scope: string, id: string) {
    const memory = this.get(scope, id);
    if (memory.scope !== scope) throw new Error("Use the global command for global memories.");
    const history = this.db.prepare("SELECT text FROM versions WHERE memory_id=?").all(id);
    for (const version of [memory, ...history]) {
      this.db.prepare("INSERT OR IGNORE INTO revoked(scope,topic,fingerprint) VALUES(?,?,?)")
        .run(scope, memory.topic, fingerprint(String(version.text)));
    }
    this.db.prepare("DELETE FROM memories WHERE id=? AND scope=?").run(id, scope);
  }

  forget(scope: string, id: string) {
    this.transaction(() => {
      this.eraseInside(scope, id);
      if (scope === GLOBAL_SCOPE) {
        // Remove exact text copies (including renamed topics) without deleting
        // unrelated, differently worded project policies sharing a topic key.
        const copies = this.db.prepare(`SELECT id,scope FROM memories WHERE EXISTS
          (SELECT 1 FROM revoked WHERE scope=? AND fingerprint=memory_fingerprint(memories.text))`).all(GLOBAL_SCOPE);
        for (const copy of copies) this.eraseInside(String(copy.scope), String(copy.id));
        this.db.prepare(`DELETE FROM versions WHERE EXISTS
          (SELECT 1 FROM revoked WHERE scope=? AND fingerprint=memory_fingerprint(versions.text))`).run(GLOBAL_SCOPE);
        const scopes = this.db.prepare("SELECT scope FROM controls UNION SELECT scope FROM jobs").all();
        for (const row of scopes) this.invalidateJobs(String(row.scope));
      }
      this.invalidateJobs(scope);
    });
    // Purge deleted FTS segments and checkpoint when other readers permit it.
    this.db.exec("INSERT INTO memory_fts(memory_fts) VALUES('optimize'); PRAGMA wal_checkpoint(TRUNCATE);");
  }

  enqueue(scope: string, payload: Payload, expectedGeneration = this.generation(scope)): boolean {
    if (!this.control(scope).learning) return false;
    const body = JSON.stringify(payload);
    if (body.length > 30000) throw new Error("Memory evidence exceeds the capture budget.");
    const id = hash(`${scope}:${payload.session}:${payload.entries.map((entry) => entry.id).join(":")}`);
    return this.transaction(() => {
      // Fence evidence captured before a revocation, even if another process
      // committed the revocation between capture and this transaction.
      if (!this.control(scope).learning || this.generation(scope) !== expectedGeneration) return false;
      const pending: any = this.db.prepare("SELECT count(*) AS n FROM jobs WHERE scope=? AND state IN ('pending','running','failed')").get(scope);
      if (pending.n >= 50) throw new Error("Memory queue is full. Run /memory retry or disable learning to discard pending work.");
      return this.db.prepare("INSERT OR IGNORE INTO jobs(id,scope,session,payload,generation,ready_at,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(id, scope, payload.session, body, this.control(scope).generation, this.now(), this.now()).changes > 0;
    });
  }

  claim(scope: string): any {
    return this.transaction(() => {
      if (!this.control(scope).learning) return undefined;
      if (this.db.prepare("SELECT 1 FROM jobs WHERE scope=? AND state='running' AND lease_until>?").get(scope, this.now())) return undefined;
      this.db.prepare("UPDATE jobs SET payload=NULL,state='expired',owner=NULL WHERE payload IS NOT NULL AND created_at<?")
        .run(this.now() - 7 * 86400000);
      this.db.prepare("UPDATE jobs SET state='failed',owner=NULL,finished_at=?,error='Worker lease expired after the final attempt.' WHERE state='running' AND lease_until<=? AND attempts>=3")
        .run(this.now(), this.now());
      const count: any = this.db.prepare("SELECT count(*) AS n FROM jobs WHERE (finished_at>? AND state IN ('done','failed')) OR (state='running' AND lease_until>?)")
        .get(this.now() - 86400000, this.now());
      if (count.n >= 20) return undefined;
      const row: any = this.db.prepare(`SELECT rowid AS sequence,* FROM jobs WHERE scope=? AND payload IS NOT NULL AND attempts<3 AND
        ((state='pending' AND ready_at<=?) OR (state='running' AND lease_until<=?)) ORDER BY created_at,rowid LIMIT 1`)
        .get(scope, this.now(), this.now());
      if (!row) return undefined;
      const owner = randomUUID();
      this.db.prepare("UPDATE jobs SET state='running',owner=?,lease_until=?,attempts=attempts+1 WHERE id=?")
        .run(owner, this.now() + 90000, row.id);
      return { ...row, owner, attempts: row.attempts + 1, payload: JSON.parse(row.payload) };
    });
  }

  finish(job: any, candidates: Candidate[], tokens = 0): any[] {
    return this.transaction(() => {
      const live: any = this.db.prepare("SELECT * FROM jobs WHERE id=? AND state='running' AND owner=? AND lease_until>?").get(job.id, job.owner, this.now());
      if (!live || live.generation !== this.control(job.scope).generation || !this.control(job.scope).learning) return [];
      const saved = candidates.map((candidate) => this.saveInside(job.scope, candidate, { evidenceAt: job.created_at, evidenceOrder: job.sequence }));
      this.db.prepare("UPDATE jobs SET state='done',payload=NULL,owner=NULL,error=NULL,finished_at=?,tokens=? WHERE id=?")
        .run(this.now(), tokens, job.id);
      return saved;
    });
  }

  fail(job: any, cancelled: boolean) {
    this.db.prepare(`UPDATE jobs SET state=?,owner=NULL,attempts=attempts-?,ready_at=?,finished_at=?,error=?
      WHERE id=? AND state='running' AND owner=?`)
      .run(cancelled || job.attempts < 3 ? "pending" : "failed", Number(cancelled),
        this.now() + (cancelled ? 0 : 30000 * 2 ** (job.attempts - 1)), cancelled ? null : this.now(),
        cancelled ? null : "Extraction failed; retry is bounded. No memory was saved.", job.id, job.owner);
  }

  retry(scope: string) {
    this.db.prepare("UPDATE jobs SET state='pending',attempts=0,ready_at=?,error=NULL WHERE scope=? AND state='failed' AND payload IS NOT NULL")
      .run(this.now(), scope);
  }

  stats(scope: string): any {
    return {
      ...this.control(scope),
      memories: this.db.prepare("SELECT count(*) AS n FROM memories WHERE scope=?").get(scope)!.n,
      global: this.db.prepare("SELECT count(*) AS n FROM memories WHERE scope=?").get(GLOBAL_SCOPE)!.n,
      jobs: this.db.prepare("SELECT state,count(*) AS count FROM jobs WHERE scope=? GROUP BY state").all(scope),
      learningTokens: this.db.prepare("SELECT coalesce(sum(tokens),0) AS n FROM jobs WHERE scope=?").get(scope)!.n,
    };
  }

  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}

function fingerprint(text: string) { return hash(text.toLowerCase().replace(/\s+/g, " ")); }

// Validate persisted quotes individually rather than treating their JSON keys as secrets.
function redactSources(json: string) {
  const sources = JSON.parse(json);
  if (!Array.isArray(sources) || sources.length > 3) return true;
  try {
    for (const source of sources) {
      safeText(source.quote, 240, "Evidence quote");
      if (typeof source.session !== "string" || typeof source.entry !== "string" || !["user", "assistant"].includes(source.role)) return true;
    }
    return false;
  } catch { return true; }
}
