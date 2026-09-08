import { combinedSources, DAY, normalizedText, RETENTION } from "./consolidation.ts";
import { packBatch } from "./batch.ts";
import { DEFAULT_BUDGET, validateBudget } from "./budget.ts";
import type { Admission, BudgetPolicy } from "./budget.ts";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GLOBAL_SCOPE, hash, KINDS, safeText, searchTerms, topicKey } from "./policy.ts";
import type { Candidate, Payload } from "./policy.ts";

export type RetrievalOptions = { purpose?: 'reading' | 'learning'; signal?: AbortSignal; allowed?: () => boolean };

export class MemoryStore {
  db: DatabaseSync;
  now: () => number;
  closed = false;
  maintenanceAt = 0;
  retrieval?: { search: (scope: string, query: string, limit: number, options: RetrievalOptions) => Promise<any[]> };

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
      this.db.function("memory_normalized", { deterministic: true }, (text) => normalizedText(String(text)));
      chmodSync(path, 0o600);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;");
      this.transaction(() => {
        const version = this.db.prepare("PRAGMA user_version").get()!.user_version;
        if (![0, 1, 2, 3, 4, 5].includes(Number(version))) throw new Error("Unsupported memory database version.");
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
          CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, reserved_at INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS requests_time ON requests(reserved_at);
          CREATE TABLE IF NOT EXISTS budget(id INTEGER PRIMARY KEY CHECK(id=1), policy TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS route_holds(route TEXT PRIMARY KEY, ready_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY,scope TEXT NOT NULL,canonical_id TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS changes_scope ON changes(scope,created_at);
          CREATE TABLE IF NOT EXISTS fingerprints(memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,PRIMARY KEY(memory_id,fingerprint));
          CREATE TABLE IF NOT EXISTS job_totals(scope TEXT PRIMARY KEY,tokens INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS job_receipts(id TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS lineage(source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,PRIMARY KEY(source_id,target_id));
          CREATE TABLE IF NOT EXISTS memory_vectors(memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
            model TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL, vector BLOB NOT NULL);
          CREATE TABLE IF NOT EXISTS retrieval_state(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL);
          INSERT OR IGNORE INTO retrieval_state VALUES(1,0);
          CREATE TRIGGER IF NOT EXISTS vector_update AFTER UPDATE ON memories BEGIN
            DELETE FROM memory_vectors WHERE memory_id=old.id;
            UPDATE retrieval_state SET epoch=epoch+1;
          END;
          CREATE TRIGGER IF NOT EXISTS vector_delete AFTER DELETE ON memories BEGIN
            UPDATE retrieval_state SET epoch=epoch+1;
          END;
          CREATE TRIGGER IF NOT EXISTS vector_insert AFTER INSERT ON memories BEGIN
            UPDATE retrieval_state SET epoch=epoch+1;
          END;
          CREATE TRIGGER IF NOT EXISTS vector_controls AFTER UPDATE ON controls BEGIN
            UPDATE retrieval_state SET epoch=epoch+1;
          END;
          PRAGMA user_version=5;
        `);
        const columns = this.db.prepare("PRAGMA table_info(memories)").all().map(row => row.name);
        if (!columns.includes("active")) this.db.exec("ALTER TABLE memories ADD COLUMN active INTEGER NOT NULL DEFAULT 1; ALTER TABLE memories ADD COLUMN retired_by TEXT;");
        this.db.exec("CREATE INDEX IF NOT EXISTS memories_normalized ON memories(scope,memory_normalized(text));");
        if (Number(version) < 4) this.db.exec(`INSERT OR IGNORE INTO fingerprints SELECT id,memory_fingerprint(text) FROM memories;
          INSERT OR IGNORE INTO fingerprints SELECT memory_id,memory_fingerprint(text) FROM versions;`);
        if (Number(version) < 3) {
          // Legacy jobs were individual requests; count known recent attempts conservatively.
          this.db.exec(`INSERT OR IGNORE INTO requests(id,reserved_at)
            SELECT 'legacy:' || id || ':' || n, max(created_at,coalesce(finished_at,created_at),lease_until-90000) FROM jobs CROSS JOIN (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3) WHERE attempts>=n;`);
        }
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
    if (history) {
      row.history = this.db.prepare("SELECT revision,text,sources,updated_at FROM versions WHERE memory_id=? ORDER BY revision DESC LIMIT 10").all(id)
        .map((version: any) => ({ ...version, sources: JSON.parse(version.sources) }));
      row.changes = this.changes(row.scope, 100).filter(change => change.canonical_id === id);
    }
    return row;
  }

  list(scope: string, limit = 30, retired = false): any[] {
    return this.db.prepare("SELECT * FROM memories WHERE scope IN (?,?) AND active=? ORDER BY pinned DESC,updated_at DESC LIMIT ?")
      .all(scope, GLOBAL_SCOPE, Number(!retired), Math.min(100, Math.max(1, limit))).map((row) => this.decode(row));
  }

  search(scope: string, query: string, limit = 8, includeGlobal = true): any[] {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const match = terms.map((term) => `"${term}"`).join(" OR ");
    return this.db.prepare(`SELECT m.* FROM memory_fts JOIN memories m ON m.rowid=memory_fts.rowid
      WHERE memory_fts MATCH ? AND m.scope IN (?,?) AND m.active=1 ORDER BY bm25(memory_fts,8,4,1),m.updated_at DESC LIMIT ?`)
      .all(match, scope, includeGlobal ? GLOBAL_SCOPE : scope, Math.min(30, Math.max(1, limit))).map((row) => this.decode(row));
  }

  async candidates(scope: string, query: string, limit = 8, options: RetrievalOptions = {}): Promise<any[]> {
    if (this.retrieval) return this.retrieval.search(scope, query, limit, options);
    return this.search(scope, query, limit);
  }

  retrievalEpoch(): number { return Number(this.db.prepare('SELECT epoch FROM retrieval_state WHERE id=1').get()!.epoch); }

  recallRows(scope: string, candidates: any[]): any[] {
    if (!this.control(scope).reading) return [];
    const pinned = this.db.prepare("SELECT * FROM memories WHERE scope IN (?,?) AND pinned=1 AND active=1 ORDER BY updated_at DESC LIMIT 4")
      .all(scope, GLOBAL_SCOPE).map((row) => this.decode(row));
    return [...new Map([...pinned, ...candidates].map((row) => [row.id, row])).values()].slice(0, 8);
  }

  recall(scope: string, query: string): any[] {
    return this.recallRows(scope, this.search(scope, query));
  }

  blocked(scope: string): string[] {
    return this.db.prepare("SELECT DISTINCT topic FROM revoked WHERE scope IN (?,?)").all(scope, GLOBAL_SCOPE).map((row: any) => row.topic);
  }

  save(scope: string, candidate: Candidate, { manual = false, pinned = false, restore = false } = {}): any {
    return this.transaction(() => this.saveInside(scope, candidate, { manual, pinned, restore }));
  }

  saveInside(scope: string, candidate: Candidate, { manual = false, pinned = false, restore = false, evidenceAt = this.now(), evidenceOrder = 0, duplicateIds = [] as string[] } = {}): any {
    const topic = topicKey(candidate.topic);
    const text = safeText(candidate.text, 1600, "Memory text");
    const keywords = candidate.keywords ? safeText(candidate.keywords, 600, "Keywords") : "";
    if (!KINDS.includes(candidate.kind)) throw new Error("Invalid memory kind.");
    if (scope === GLOBAL_SCOPE && !manual) throw new Error("Global memory requires an explicit user command.");
    const digest = fingerprint(text);
    if (restore && manual) this.db.prepare("DELETE FROM revoked WHERE scope=? AND (topic=? OR fingerprint=?)").run(scope, topic, digest);
    if (this.db.prepare("SELECT 1 FROM revoked WHERE scope IN (?,?) AND (topic=? OR fingerprint=?)").get(scope, GLOBAL_SCOPE, topic, digest)) return { skipped: "revoked", topic };
    const existing: any = this.db.prepare("SELECT * FROM memories WHERE scope=? AND topic=?").get(scope, topic);
    if ((existing?.manual || existing?.pinned || existing?.active === 0) && !manual) return { skipped: existing.manual ? "manual" : existing.pinned ? "pinned" : "retired", topic };
    if (existing && !manual && (existing.evidence_at > evidenceAt || (existing.evidence_at === evidenceAt && existing.evidence_order > evidenceOrder))) return { skipped: "stale", topic };
    const duplicate: any = this.db.prepare("SELECT id FROM memories WHERE scope=? AND memory_normalized(text)=memory_normalized(?) AND topic<>?").all(scope, text, topic).find(row => !duplicateIds.includes(String(row.id)));
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
    this.db.prepare("INSERT OR IGNORE INTO fingerprints VALUES(?,?)").run(id, digest);
    if (manual) this.db.prepare("UPDATE memories SET active=1,retired_by=NULL WHERE id=?").run(id);
    return this.get(scope, id);
  }

  /** Candidate evidence is new; target IDs/revisions are fenced by the exact prompt snapshot. */
  consolidateInside(scope: string, candidate: Candidate, evidenceAt: number, evidenceOrder: number, offered: any[] = []) {
    const operation = candidate.consolidation;
    // Direct store callers retain legacy saves; model output always carries an action.
    if (!operation) return this.saveInside(scope, candidate, { evidenceAt, evidenceOrder });
    if (operation.action === "ignore") return { skipped: "redundant", topic: candidate.topic };
    if (operation.action === "add") {
      if (this.db.prepare("SELECT 1 FROM memories WHERE scope=? AND topic=?").get(scope, candidate.topic)) return { skipped: "existing-topic", topic: candidate.topic };
      return this.saveInside(scope, candidate, { evidenceAt, evidenceOrder });
    }
    if (!["merge", "supersede"].includes(operation.action) || !operation.targets.length || operation.targets.length > 3) throw new Error("Invalid consolidation.");
    if (operation.action === "supersede" && !candidate.sources.some(source => source.role === "user")) throw new Error("Supersession requires user evidence.");
    const before = operation.targets.map(target => {
      if (!offered.some(memory => memory.id === target.id && memory.revision === target.revision)) throw new Error("Target was not supplied for this request.");
      return this.decode(this.db.prepare("SELECT * FROM memories WHERE scope=? AND id=?").get(scope, target.id));
    });
    if (before.some(memory => !memory)) return { skipped: "stale-or-protected", topic: candidate.topic };
    if (new Set(before.map(memory => memory.id)).size !== before.length) throw new Error("Duplicate target.");
    if (before.some((memory, i) => memory.scope !== scope || !memory.active || memory.manual || memory.pinned || memory.revision !== operation.targets[i].revision || memory.evidence_at > evidenceAt || (memory.evidence_at === evidenceAt && memory.evidence_order > evidenceOrder))) return { skipped: "stale-or-protected", topic: candidate.topic };
    const canonical = before.find(memory => memory.topic === candidate.topic);
    if (!canonical) throw new Error("Consolidation must reuse a target topic.");
    if (before.length === 1 && normalizedText(canonical.text) === normalizedText(candidate.text)) return { skipped: "redundant", id: canonical.id };
    // A merged record carries every retained source, not just the newest paraphrase.
    let sources;
    try { sources = operation.action === "merge" ? combinedSources([...before.map(memory => memory.sources), candidate.sources]) : candidate.sources; }
    catch { return { skipped: "evidence-budget", topic: candidate.topic }; }
    const keywords = operation.action === "merge" ? [...new Set([...before.map(memory => memory.keywords), candidate.keywords].join(" ").split(/\s+/))].join(" ") : candidate.keywords;
    if (keywords.length > 600) return { skipped: "keyword-budget", topic: candidate.topic };
    const reason = safeText(operation.reason, 300, "Consolidation reason");
    // Aliases being retired must not block the replacement as exact duplicates.
    const aliases = before.filter(memory => memory.id !== canonical.id);
    const duplicate: any = this.db.prepare("SELECT id FROM memories WHERE scope=? AND memory_normalized(text)=memory_normalized(?) AND id<>?").all(scope, candidate.text, canonical.id).find(row => !aliases.some(memory => memory.id === row.id));
    if (duplicate) return { skipped: "duplicate", id: duplicate.id };
    // saveInside has its own duplicate guard; bypass only the IDs explicitly validated above.
    const saved = this.saveInside(scope, { ...candidate, sources, keywords }, { evidenceAt, evidenceOrder, duplicateIds: aliases.map(memory => memory.id) });
    if (saved.skipped) return saved;
    const id = randomUUID();
    for (const memory of aliases) {
      this.db.prepare("UPDATE memories SET active=0,retired_by=?,revision=revision+1,updated_at=? WHERE id=?").run(canonical.id, this.now(), memory.id);
      this.db.prepare("INSERT OR IGNORE INTO lineage VALUES(?,?)").run(memory.id, canonical.id);
    }
    const after = before.map(memory => ({ id: memory.id, revision: this.get(scope, memory.id).revision }));
    this.db.prepare("INSERT INTO changes VALUES(?,?,?,?,?,?,?,?)").run(id, scope, canonical.id, operation.action, reason, JSON.stringify(before), JSON.stringify(after), this.now());
    return { ...saved, changeId: id, retired: aliases.map(memory => memory.id) };
  }

  changes(scope: string, limit = 30): any[] {
    return this.db.prepare("SELECT id,canonical_id,action,reason,created_at FROM changes WHERE scope=? ORDER BY created_at DESC,rowid DESC LIMIT ?")
      .all(scope, Math.min(100, Math.max(1, limit)));
  }

  undo(scope: string, id: string) {
    return this.transaction(() => {
      const change: any = this.db.prepare("SELECT * FROM changes WHERE id=? AND scope=?").get(id, scope);
      if (!change) throw new Error("Consolidation not found or undo retention expired.");
      const before: any[] = JSON.parse(change.before_json), after: any[] = JSON.parse(change.after_json);
      for (const target of after) {
        const current = this.get(scope, target.id);
        if (current.scope !== scope || current.revision !== target.revision || current.manual || current.pinned) throw new Error("Memory changed since consolidation; undo would overwrite newer work.");
      }
      for (const memory of before) {
        if (this.db.prepare("SELECT 1 FROM revoked WHERE scope IN (?,?) AND (topic=? OR fingerprint=?)").get(scope, GLOBAL_SCOPE, memory.topic, fingerprint(memory.text))) throw new Error("Undo cannot restore forgotten knowledge.");
        const current = this.get(scope, memory.id);
        this.db.prepare("INSERT OR IGNORE INTO versions VALUES(?,?,?,?,?)").run(current.id, current.revision, current.text, JSON.stringify(current.sources), current.updated_at);
        // Undo is an explicit user correction: automatic learning cannot immediately redo it.
        this.db.prepare("UPDATE memories SET kind=?,text=?,keywords=?,sources=?,manual=1,pinned=?,active=?,retired_by=?,evidence_at=?,evidence_order=?,revision=revision+1,updated_at=? WHERE id=?")
          .run(memory.kind, memory.text, memory.keywords, JSON.stringify(memory.sources), memory.pinned, memory.active, memory.retired_by, memory.evidence_at, memory.evidence_order, this.now(), memory.id);
      }
      this.db.prepare("DELETE FROM changes WHERE id=?").run(id);
      this.invalidateJobs(scope);
      return { undone: id, restored: before.map(memory => memory.id), manual: true };
    });
  }

  /** No knowledge-age deletion: only bounded history and terminal operational data. */
  maintain(force = false) {
    if (!force && this.maintenanceAt > this.now()) return;
    this.transaction(() => {
      this.expireJobs();
      // Preserve deletion fingerprints even when old text revisions are pruned.
      this.db.exec("INSERT OR IGNORE INTO fingerprints SELECT memory_id,memory_fingerprint(text) FROM versions;");
      this.db.prepare(`DELETE FROM versions WHERE (memory_id,revision) IN
        (SELECT memory_id,revision FROM (SELECT memory_id,revision,row_number() OVER(PARTITION BY memory_id ORDER BY revision DESC) n FROM versions) WHERE n>?)`).run(RETENTION.revisions);
      this.db.prepare(`DELETE FROM changes WHERE created_at<? OR id IN
        (SELECT id FROM (SELECT id,row_number() OVER(PARTITION BY canonical_id ORDER BY created_at DESC,rowid DESC) n FROM changes) WHERE n>?)`).run(this.now() - RETENTION.changeDays * DAY, RETENTION.changesPerMemory);
      const cutoff = this.now() - RETENTION.jobDays * DAY;
      this.db.prepare(`INSERT INTO job_totals SELECT scope,sum(tokens) FROM jobs WHERE state IN ('done','cancelled','expired','failed') AND payload IS NULL AND coalesce(finished_at,created_at)<? GROUP BY scope
        ON CONFLICT(scope) DO UPDATE SET tokens=tokens+excluded.tokens`).run(cutoff);
      this.db.prepare("INSERT OR IGNORE INTO job_receipts SELECT id FROM jobs WHERE state IN ('done','cancelled','expired','failed') AND payload IS NULL AND coalesce(finished_at,created_at)<?").run(cutoff);
      this.db.prepare("DELETE FROM jobs WHERE state IN ('done','cancelled','expired','failed') AND payload IS NULL AND coalesce(finished_at,created_at)<?").run(cutoff);
      this.db.prepare("DELETE FROM requests WHERE reserved_at<? AND NOT EXISTS(SELECT 1 FROM jobs WHERE owner=requests.id AND state='running')").run(this.now() - RETENTION.requestDays * DAY);
    });
    this.maintenanceAt = this.now() + 3600000;
  }

  pin(scope: string, id: string, pinned: boolean) {
    const memory = this.get(scope, id);
    if (memory.scope !== scope) throw new Error("Use the global command for global memories.");
    if (!memory.active) throw new Error("Retired memories cannot be pinned; undo their consolidation first.");
    this.db.prepare("UPDATE memories SET pinned=?,revision=revision+1 WHERE id=? AND scope=?").run(Number(pinned), id, scope);
    return this.get(scope, id);
  }

  eraseInside(scope: string, id: string, visited = new Set<string>()) {
    if (visited.has(id)) return;
    visited.add(id);
    const memory = this.get(scope, id);
    if (memory.scope !== scope) throw new Error("Use the global command for global memories.");
    const history = this.db.prepare("SELECT text FROM versions WHERE memory_id=?").all(id);
    for (const version of [memory, ...history]) {
      this.db.prepare("INSERT OR IGNORE INTO revoked(scope,topic,fingerprint) VALUES(?,?,?)")
        .run(scope, memory.topic, fingerprint(String(version.text)));
    }
    this.db.prepare("INSERT OR IGNORE INTO revoked SELECT ?,?,fingerprint FROM fingerprints WHERE memory_id=?").run(scope, memory.topic, id);
    const related = this.db.prepare(`SELECT id FROM memories WHERE scope=? AND (retired_by=? OR id=? OR id IN
      (SELECT target_id FROM lineage WHERE source_id=? UNION SELECT source_id FROM lineage WHERE target_id=?))`).all(scope, id, memory.retired_by, id, id);
    this.db.prepare("DELETE FROM changes WHERE id IN (SELECT c.id FROM changes c,json_each(c.before_json) j WHERE json_extract(j.value,'$.id')=?)").run(id);
    for (const row of related) this.eraseInside(scope, String(row.id), visited);
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
        for (const copy of copies) if (this.db.prepare("SELECT 1 FROM memories WHERE id=?").get(copy.id)) this.eraseInside(String(copy.scope), String(copy.id));
        this.db.prepare(`DELETE FROM versions WHERE EXISTS
          (SELECT 1 FROM revoked WHERE scope=? AND fingerprint=memory_fingerprint(versions.text))`).run(GLOBAL_SCOPE);
        this.db.prepare(`DELETE FROM changes WHERE id IN (SELECT c.id FROM changes c,json_each(c.before_json) j WHERE EXISTS
          (SELECT 1 FROM revoked WHERE scope=? AND fingerprint=memory_fingerprint(json_extract(j.value,'$.text'))))`).run(GLOBAL_SCOPE);
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
    if (Buffer.byteLength(body) > 30000) throw new Error("Memory evidence exceeds the capture budget.");
    const id = hash(`${scope}:${payload.session}:${hash(body)}`);
    return this.transaction(() => {
      // Fence evidence captured before a revocation, even if another process
      // committed the revocation between capture and this transaction.
      if (!this.control(scope).learning || this.generation(scope) !== expectedGeneration) return false;
      if (this.db.prepare("SELECT 1 FROM job_receipts WHERE id=?").get(id)) return false;
      const pending: any = this.db.prepare("SELECT count(*) AS n FROM jobs WHERE scope=? AND state IN ('pending','running','failed')").get(scope);
      if (pending.n >= 50) throw new Error("Memory queue is full. Run /memory retry or disable learning to discard pending work.");
      return this.db.prepare("INSERT OR IGNORE INTO jobs(id,scope,session,payload,generation,ready_at,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(id, scope, payload.session, body, this.control(scope).generation, this.now(), this.now()).changes > 0;
    });
  }

  holdStockQuota(nextAt: number) {
    // No credential inspection: all unknown stock Codex identities share this conservative route hold.
    this.db.prepare("INSERT INTO route_holds VALUES('openai-codex:stock:unknown',?) ON CONFLICT(route) DO UPDATE SET ready_at=max(ready_at,excluded.ready_at)")
      .run(Math.max(this.now() + 1000, nextAt));
  }

  stockQuotaAdmission(): Admission | undefined {
    const row: any = this.db.prepare("SELECT ready_at FROM route_holds WHERE route='openai-codex:stock:unknown' AND ready_at>?").get(this.now());
    return row ? { allowed: false, mode: "fallback", reason: "subscription quota (stock identity unknown)", nextAt: row.ready_at } : undefined;
  }

  budget(): BudgetPolicy {
    const row: any = this.db.prepare("SELECT policy FROM budget WHERE id=1").get();
    return row ? validateBudget(JSON.parse(row.policy)) : { ...DEFAULT_BUDGET };
  }

  setBudget(key: string, value: number) {
    this.transaction(() => {
      const policy = validateBudget({ ...this.budget(), [key]: value });
      this.db.prepare("INSERT INTO budget VALUES(1,?) ON CONFLICT(id) DO UPDATE SET policy=excluded.policy").run(JSON.stringify(policy));
    });
  }

  dailyBudget(mode: "quota" | "fallback" = "fallback") {
    const limit = this.budget()[mode];
    const rows: any[] = this.db.prepare("SELECT reserved_at FROM requests WHERE reserved_at>? ORDER BY reserved_at")
      .all(this.now() - 86400000);
    return { used: rows.length, limit, nextAt: rows.length >= limit ? rows[rows.length - limit].reserved_at + 86400000 : undefined };
  }

  pendingRows(scope: string, includeWaiting = false): any[] {
    return this.db.prepare(`SELECT rowid AS sequence,* FROM jobs WHERE scope=? AND payload IS NOT NULL AND attempts<3 AND
      generation=? AND created_at>=? AND ((state='pending' AND ready_at<=?) OR (state='running' AND lease_until<=?)) ORDER BY created_at,rowid`)
      .all(scope, this.control(scope).generation, this.now() - 7 * 86400000, includeWaiting ? Number.MAX_SAFE_INTEGER : this.now(), this.now());
  }

  reconcileLeases() {
    this.db.prepare("UPDATE jobs SET state='failed',owner=NULL,finished_at=?,error='Worker lease expired after the final attempt.' WHERE state='running' AND lease_until<=? AND attempts>=3")
      .run(this.now(), this.now());
  }

  expireJobs() {
    this.reconcileLeases();
    this.db.prepare("UPDATE jobs SET payload=NULL,state='expired',owner=NULL WHERE payload IS NOT NULL AND created_at<? AND NOT(state='running' AND lease_until>?)")
      .run(this.now() - 7 * 86400000, this.now());
  }

  nextReadyAt(scope: string): number | undefined {
    const row: any = this.db.prepare("SELECT min(ready_at) AS next FROM jobs WHERE scope=? AND state='pending' AND payload IS NOT NULL AND ready_at>?").get(scope, this.now());
    return row?.next ?? undefined;
  }

  hasPending(scope: string) { return !!this.control(scope).learning && this.pendingRows(scope).length > 0; }

  claim(scope: string, mode: "quota" | "fallback" = "fallback"): any {
    return this.transaction(() => {
      if (!this.control(scope).learning) return undefined;
      if (this.db.prepare("SELECT 1 FROM jobs WHERE scope=? AND state='running' AND lease_until>?").get(scope, this.now())) return undefined;
      this.db.prepare("UPDATE jobs SET payload=NULL,state='expired',owner=NULL WHERE payload IS NOT NULL AND created_at<?")
        .run(this.now() - 7 * 86400000);
      this.reconcileLeases();
      if (this.dailyBudget(mode).nextAt) return undefined;
      const batch = packBatch(this.pendingRows(scope));
      if (!batch) return undefined;
      const owner = randomUUID();
      this.db.prepare("INSERT INTO requests VALUES(?,?)").run(owner, this.now());
      for (const member of batch.members) {
        this.db.prepare("UPDATE jobs SET state='running',owner=?,lease_until=?,attempts=attempts+1 WHERE id=?")
          .run(owner, this.now() + 90000, member.id);
        member.attempts++;
      }
      return { ...batch, owner, attempts: batch.members[0].attempts };
    });
  }

  liveBatch(job: any) {
    return this.control(job.scope).learning && job.members.every((member: any) => {
      const live: any = this.db.prepare("SELECT generation FROM jobs WHERE id=? AND state='running' AND owner=? AND lease_until>?")
        .get(member.id, job.owner, this.now());
      return live && live.generation === this.control(job.scope).generation;
    });
  }

  finish(job: any, candidates: Candidate[], tokens = 0, offered: any[] = []): any[] {
    return this.transaction(() => {
      if (!this.liveBatch(job)) return [];
      const saved = candidates.map(candidate => {
        const origins = candidate.sources.map(source => job.origins[source.entry]).filter(Boolean)
          .sort((a: any, b: any) => b.created_at - a.created_at || b.sequence - a.sequence);
        const origin = origins[0] ?? job;
        return this.consolidateInside(job.scope, candidate, origin.created_at, origin.sequence, offered);
      });
      for (const [index, member] of job.members.entries()) {
        const remainder = member.remainder.length ? JSON.stringify({ session: member.session, entries: member.remainder }) : null;
        this.db.prepare("UPDATE jobs SET state=?,payload=?,owner=NULL,error=NULL,finished_at=?,tokens=tokens+?,attempts=? WHERE id=?")
          .run(remainder ? "pending" : "done", remainder, remainder ? null : this.now(), index === 0 ? tokens : 0, remainder ? 0 : member.attempts, member.id);
      }
      return saved;
    });
  }

  fail(job: any, cancelled: boolean, unsubmitted = false, deferred = false, nextAt?: number) {
    this.transaction(() => {
      // Refund only a proven pre-submission deferral, never a cancelled provider call.
      if (unsubmitted) this.db.prepare("DELETE FROM requests WHERE id=?").run(job.owner);
      if (!this.liveBatch(job)) return;
      for (const member of job.members) {
        const attempts = member.attempts - Number(unsubmitted || deferred);
        this.db.prepare(`UPDATE jobs SET state=?,owner=NULL,attempts=?,ready_at=?,finished_at=?,error=? WHERE id=? AND owner=?`)
          .run(attempts < 3 ? "pending" : "failed", attempts,
            deferred ? Math.max(this.now() + 1000, nextAt ?? this.now() + (unsubmitted ? 0 : 60000)) : this.now() + (cancelled ? 0 : 30000 * 2 ** (attempts - 1)), cancelled ? null : this.now(),
            cancelled ? null : "Extraction failed; retry is bounded. No memory was saved.", member.id, job.owner);
      }
    });
  }

  retry(scope: string) {
    this.db.prepare("UPDATE jobs SET state='pending',attempts=0,ready_at=?,error=NULL WHERE scope=? AND state='failed' AND payload IS NOT NULL")
      .run(this.now(), scope);
  }

  stats(scope: string): any {
    return {
      ...this.control(scope),
      budget: this.budget(), daily: this.dailyBudget(), nextAt: this.nextReadyAt(scope),
      batches: (() => {
        let rows = this.pendingRows(scope, true), count = 0;
        while (rows.length) {
          const batch = packBatch(rows);
          if (!batch) break;
          count++;
          const ids = new Set(batch.members.map((member: any) => member.id));
          rows = rows.filter(row => !ids.has(row.id));
          for (const member of batch.members) if (member.remainder.length) rows.unshift({ ...member, payload: { session: member.session, entries: member.remainder } });
        }
        return count;
      })(),
      memories: this.db.prepare("SELECT count(*) AS n FROM memories WHERE scope=? AND active=1").get(scope)!.n,
      retired: this.db.prepare("SELECT count(*) AS n FROM memories WHERE scope=? AND active=0").get(scope)!.n,
      undoable: this.db.prepare("SELECT count(*) AS n FROM changes WHERE scope=?").get(scope)!.n,
      global: this.db.prepare("SELECT count(*) AS n FROM memories WHERE scope=?").get(GLOBAL_SCOPE)!.n,
      jobs: this.db.prepare("SELECT state,count(*) AS count FROM jobs WHERE scope=? GROUP BY state").all(scope),
      learningTokens: Number(this.db.prepare("SELECT coalesce(sum(tokens),0) AS n FROM jobs WHERE scope=?").get(scope)!.n) + Number(this.db.prepare("SELECT tokens FROM job_totals WHERE scope=?").get(scope)?.tokens ?? 0),
    };
  }

  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}

function fingerprint(text: string) { return hash(text.toLowerCase().replace(/\s+/g, " ")); }

// Validate persisted quotes individually rather than treating their JSON keys as secrets.
function redactSources(json: string) {
  const sources = JSON.parse(json);
  if (!Array.isArray(sources) || sources.length > 12) return true;
  try {
    for (const source of sources) {
      safeText(source.quote, 240, "Evidence quote");
      if (typeof source.session !== "string" || typeof source.entry !== "string" || !["user", "assistant"].includes(source.role)) return true;
    }
    return false;
  } catch { return true; }
}
