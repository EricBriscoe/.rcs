import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, lstatSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class TaskStore {
  db: DatabaseSync;
  constructor(path: string) {
    const dir = dirname(path);
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error("Task state directory must not be a symlink.");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Task database must not be a symlink.");
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS tasks(
          id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, request TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'queued', revision INTEGER NOT NULL DEFAULT 0,
          plan TEXT, workspace TEXT, resource TEXT, owner TEXT, pid INTEGER, lease INTEGER,
          result TEXT, question TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS task_session ON tasks(session,state,id);
        CREATE TABLE IF NOT EXISTS projects(alias TEXT PRIMARY KEY,path TEXT NOT NULL);
      `);
    } catch (error) { this.db.close(); throw error; }
  }
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  decode(row: any): any { return row ? { ...row, plan: row.plan ? JSON.parse(row.plan) : null } : undefined; }
  get(session: string, id: number): any {
    const row = this.decode(this.db.prepare("SELECT * FROM tasks WHERE session=? AND id=?").get(session, id));
    if (!row) throw new Error("Task does not belong to this Pi session.");
    return row;
  }
  list(session: string): any[] { return this.db.prepare("SELECT * FROM tasks WHERE session=? ORDER BY id").all(session).map(row => this.decode(row)); }
  add(session: string, request: string, limit = 100): any {
    if (!request.trim() || request.length > 16000) throw new Error("Tasks must contain 1–16,000 characters.");
    return this.tx(() => {
      const outstanding: any = this.db.prepare("SELECT count(*) AS n FROM tasks WHERE session=? AND state NOT IN ('done','cancelled')").get(session);
      if (outstanding.n >= limit) throw new Error("Task queue is full. Resolve or cancel existing tasks before submitting more.");
      const result = this.db.prepare("INSERT INTO tasks(session,request,created,updated) VALUES(?,?,?,?)").run(session, request, Date.now(), Date.now());
      return this.get(session, Number(result.lastInsertRowid));
    });
  }
  projects(): Record<string, string> { return Object.fromEntries(this.db.prepare("SELECT alias,path FROM projects").all().map(row => [String(row.alias), String(row.path)])); }
  project(alias: string, path: string) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(alias) || alias === "current") throw new Error("Choose a lowercase project alias other than 'current'.");
    this.db.prepare("INSERT INTO projects(alias,path) VALUES(?,?) ON CONFLICT(alias) DO UPDATE SET path=excluded.path").run(alias, path);
  }
  claimPlan(session: string, owner: string): any {
    return this.tx(() => {
      const row: any = this.db.prepare("SELECT * FROM tasks WHERE session=? AND state='queued' ORDER BY id LIMIT 1").get(session);
      if (!row) return undefined;
      this.db.prepare("UPDATE tasks SET state='planning',owner=?,pid=?,lease=?,updated=? WHERE id=?").run(owner, process.pid, Date.now() + 120000, Date.now(), row.id);
      return this.get(session, row.id);
    });
  }
  planned(task: any, owner: string, plan: any, workspace: string | null, resource: string | null) {
    return this.db.prepare("UPDATE tasks SET state=?,plan=?,workspace=?,resource=?,question=?,owner=NULL,pid=NULL,lease=NULL,updated=? WHERE id=? AND session=? AND revision=? AND owner=? AND state='planning'")
      .run(plan.question ? "blocked" : "ready", JSON.stringify(plan), workspace, resource, plan.question || null, Date.now(), task.id, task.session, task.revision, owner).changes > 0;
  }
  claimRun(session: string, id: number, owner: string): any {
    return this.tx(() => {
      const task = this.get(session, id);
      if (task.state !== "ready") return undefined;
      // Readers can overlap one another, but never overlap a writer. Worktrees
      // share their Git-common key; nested non-Git workspaces also conflict.
      const busy = this.db.prepare("SELECT workspace,resource,plan FROM tasks WHERE state IN ('running','waiting','stopping') AND workspace IS NOT NULL").all().map(row => this.decode(row));
      if (busy.some(other => !(task.plan.role === "scout" && other.plan?.role === "scout") && (other.resource === task.resource || other.workspace === task.workspace || other.workspace.startsWith(task.workspace + "/") || task.workspace.startsWith(other.workspace + "/")))) return undefined;
      for (const dependency of task.plan.dependencies) {
        const prior = this.get(session, dependency);
        if (prior.state !== "done") return undefined;
      }
      this.db.prepare("UPDATE tasks SET state='running',owner=?,pid=?,lease=?,updated=? WHERE id=?")
        .run(owner, process.pid, Date.now() + 120000, Date.now(), id);
      return this.get(session, id);
    });
  }
  runDetails(task: any, owner: string, model: string, log: string) {
    const plan = JSON.stringify({ ...task.plan, execution: { model, log } });
    if (!this.db.prepare("UPDATE tasks SET plan=?,updated=? WHERE id=? AND owner=? AND revision=? AND state='running'").run(plan, Date.now(), task.id, owner, task.revision).changes) throw new Error("Task ownership changed before worker startup.");
  }
  heartbeat(owner: string) { this.db.prepare("UPDATE tasks SET lease=? WHERE owner=? AND state IN ('planning','running','waiting','stopping')").run(Date.now() + 120000, owner); }
  waiting(task: any, owner: string, question: string) {
    this.db.prepare("UPDATE tasks SET state='waiting',question=?,updated=? WHERE id=? AND owner=? AND revision=? AND state IN ('running','waiting')").run(question.slice(0, 4000), Date.now(), task.id, owner, task.revision);
  }
  recordReply(task: any, owner: string, text: string) {
    this.tx(() => {
      const current = this.get(task.session, task.id);
      if (current.state !== "waiting" || current.owner !== owner || current.revision !== task.revision) throw new Error("Task is no longer waiting for that reply.");
      const request = `${current.request}\n\nUser reply to worker question (${current.question}): ${text}`;
      if (request.length > 16000) throw new Error("Task reply history exceeds 16,000 characters. Submit a new task.");
      this.db.prepare("UPDATE tasks SET request=?,updated=? WHERE id=?").run(request, Date.now(), task.id);
    });
  }
  answered(task: any, owner: string) { this.db.prepare("UPDATE tasks SET state='running',question=NULL WHERE id=? AND owner=? AND revision=? AND state='waiting'").run(task.id, owner, task.revision); }
  finish(task: any, owner: string, state: string, result: string) {
    if (!["done", "failed", "paused"].includes(state)) throw new Error("Invalid task completion.");
    return this.db.prepare("UPDATE tasks SET state=?,result=?,question=NULL,owner=NULL,pid=NULL,lease=NULL,updated=? WHERE id=? AND session=? AND revision=? AND owner=? AND state IN ('planning','running','waiting')")
      .run(state, result.slice(0, 18000), Date.now(), task.id, task.session, task.revision, owner).changes > 0;
  }
  stopping(session: string, id: number, owner: string) {
    this.tx(() => {
      const task = this.get(session, id);
      if (task.owner && task.owner !== owner) throw new Error("That task is owned by another live Pi instance.");
      this.db.prepare("UPDATE tasks SET state='stopping',revision=revision+1,updated=? WHERE session=? AND id=?").run(Date.now(), session, id);
    });
  }
  parked(session: string, id: number, state: "paused" | "cancelled") {
    this.db.prepare("UPDATE tasks SET state=?,owner=NULL,pid=NULL,lease=NULL,question=NULL,updated=? WHERE session=? AND id=? AND state='stopping'")
      .run(state, Date.now(), session, id);
  }
  resume(session: string, id: number, amendment = "") {
    return this.tx(() => {
      const task = this.get(session, id);
      if (!["paused", "failed", "blocked", "done", "cancelled"].includes(task.state)) throw new Error("Pause a running task before revising it.");
      const request = amendment ? `${task.request}\n\nUser follow-up: ${amendment}` : task.request;
      if (request.length > 16000) throw new Error("Task history exceeds 16,000 characters. Submit a new task.");
      this.db.prepare("UPDATE tasks SET state='queued',request=?,plan=NULL,question=NULL,revision=revision+1,updated=? WHERE id=?").run(request, Date.now(), id);
      return this.get(session, id);
    });
  }
  recover() {
    // Never automatically repeat potentially side-effecting work after a crash.
    for (const row of this.db.prepare("SELECT id,pid FROM tasks WHERE state IN ('planning','running','waiting','stopping') AND lease<?").all(Date.now())) {
      let alive = false;
      try { process.kill(Number(row.pid), 0); alive = true; } catch (error: any) { alive = error.code !== "ESRCH"; }
      if (!alive) this.db.prepare("UPDATE tasks SET state='paused',revision=revision+1,owner=NULL,pid=NULL,lease=NULL,result='Interrupted; inspect partial changes before resuming.' WHERE id=?").run(row.id);
    }
  }
  close() { this.db.close(); }
}

export const ownerId = () => randomUUID();
