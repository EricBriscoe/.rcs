import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync, existsSync, chmodSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, relative, isAbsolute, extname, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const exec = promisify(execFile);
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const inside = (path: string, root: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"); };
export const fileKind = (path: string) => extname(path).toLowerCase() || basename(path);
export const manifest = (path: string) => /(^|\/)(package\.json|[jt]sconfig[^/]*\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml|Gemfile|composer\.json|\.clangd|compile_commands\.json)$|\.(csproj|sln)$/.test(path);
export const codeKind = (kind: string) => /^(\.(?:[cm]?[jt]sx?|pyi?|go|rs|c|cc|cpp|cxx|h|hpp|java|kt|cs|swift|rb|php|lua|sh|bash|zsh|vue|svelte|scala|exs?|erl|clj|cljs|dart|zig|ml|mli|hs|fsx?|sql|tf|ya?ml|html?|css|scss|less|jsonc?|toml|mdx?)|Dockerfile|Makefile|zshrc)$/.test(kind);

export function privateDir(path: string) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Navigation state must not be a symlink.");
  mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700);
}
export async function target(root: string, path: string) {
  const result = await realpath(resolve(root, path.replace(/^@/, "")));
  if (!inside(result, root)) throw new Error("Path escapes the selected workspace (including symlinks).");
  return result;
}
export async function projectRoot(cwd: string, worker = false) {
  const canonical = await realpath(cwd);
  if (worker) return canonical; // Never widen a delegated subdirectory to its enclosing repository.
  try { return await realpath((await exec("git", ["-C", canonical, "rev-parse", "--show-toplevel"], { timeout: 3000 })).stdout.trim()); }
  catch { return canonical; }
}
export async function inventory(root: string) {
  if ([await realpath(homedir()), "/"].includes(root)) return { fingerprint: "not-a-project", files: [], kinds: {}, otherKinds: {}, truncated: false, broad: true };
  let paths: string[];
  try {
    const { stdout } = await exec("fd", ["--type", "f", "--hidden", "--color=never", "--print0", "--max-results", "20001", "--exclude", ".git", "--exclude", "node_modules", "--exclude", ".venv", "--exclude", "venv", "--exclude", "target", "--exclude", "vendor", ".", "."], { cwd: root, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    paths = stdout.split("\0").filter(Boolean).map(p => p.replace(/^\.\//, "")).sort();
  } catch { throw new Error("Could not inventory project files. Ensure fd is installed; do not mark LSP assessment complete."); }
  const truncated = paths.length > 20000;
  paths = paths.slice(0, 20000);
  const kinds: Record<string, { count: number; examples: string[] }> = Object.create(null);
  const otherKinds: Record<string, { count: number; examples: string[] }> = Object.create(null);
  for (const path of paths) {
    const kind = fileKind(path);
    const group = codeKind(kind) ? kinds : otherKinds;
    if (!Object.hasOwn(group, kind) && Object.keys(group).length >= 100) continue;
    const entry = group[kind] ??= { count: 0, examples: [] };
    entry.count++; if (entry.examples.length < 4) entry.examples.push(path);
  }
  const manifests = paths.filter(manifest);
  const signatures = [];
  for (const path of manifests.slice(0, 100)) {
    const safe = await target(root, path);
    const size = (await stat(safe)).size;
    signatures.push([path, size <= 128000 ? digest(await readFile(safe, "utf8")) : `large:${size}:${(await stat(safe)).mtimeMs}`]);
  }
  return { fingerprint: digest(JSON.stringify([[...new Set(paths.map(fileKind))].sort(), manifests, signatures])), files: paths, kinds, otherKinds, truncated: truncated || manifests.length > 100, broad: false };
}

export type ServerConfig = { id: string; directory: string; command: string[]; languages: Record<string, string>; settings?: any; initializationOptions?: any; version: string };
export function matches(config: ServerConfig, root: string, path: string) { return inside(path, resolve(root, config.directory)) && Object.hasOwn(config.languages, fileKind(path)); }

export class NavState {
  db: DatabaseSync;
  constructor(dir: string) {
    privateDir(dir);
    const path = join(dir, "state.sqlite");
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Navigation database must not be a symlink.");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS approved_roots(root TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS tooling_locks(id TEXT PRIMARY KEY,pid INTEGER NOT NULL,owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS servers(root TEXT,id TEXT,config TEXT NOT NULL,PRIMARY KEY(root,id));
      CREATE TABLE IF NOT EXISTS assessments(root TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,summary TEXT NOT NULL,skipped TEXT NOT NULL,updated INTEGER NOT NULL);`);
  }
  approved(root: string) { return !!this.db.prepare("SELECT root FROM approved_roots WHERE root=?").get(root); }
  approve(root: string) { this.db.prepare("INSERT OR IGNORE INTO approved_roots VALUES(?)").run(root); }
  servers(root: string): ServerConfig[] { return this.db.prepare("SELECT config FROM servers WHERE root=? ORDER BY id").all(root).map(row => JSON.parse(String(row.config))); }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  save(root: string, config: ServerConfig) {
    this.transaction(() => {
      this.db.prepare("INSERT INTO servers VALUES(?,?,?) ON CONFLICT(root,id) DO UPDATE SET config=excluded.config").run(root, config.id, JSON.stringify(config));
      this.reset(root);
    });
  }
  remove(root: string, id: string) { this.transaction(() => { this.db.prepare("DELETE FROM servers WHERE root=? AND id=?").run(root, id); this.reset(root); }); }
  assessment(root: string): any { return this.db.prepare("SELECT * FROM assessments WHERE root=?").get(root); }
  reset(root: string) { this.db.prepare("DELETE FROM assessments WHERE root=?").run(root); }
  complete(root: string, scan: Awaited<ReturnType<typeof inventory>>, summary: string, skipped: Record<string, string>) {
    if (!summary.trim()) throw new Error("Describe the assessment, including any unsupported languages.");
    this.transaction(() => {
      const configured = this.servers(root);
      const missing = [...new Set(scan.files.filter(path => codeKind(fileKind(path)) && !configured.some(server => matches(server, root, resolve(root, path))) && !skipped[fileKind(path)]?.trim()).map(fileKind))];
      if (missing.length) throw new Error(`Configure or explicitly explain why LSP is unnecessary/unavailable for: ${missing.join(", ")}`);
      if (scan.truncated) throw new Error("Inventory exceeded its limit. Assess narrower project roots instead of claiming complete coverage.");
      this.db.prepare("INSERT INTO assessments VALUES(?,?,?,?,?) ON CONFLICT(root) DO UPDATE SET fingerprint=excluded.fingerprint,summary=excluded.summary,skipped=excluded.skipped,updated=excluded.updated")
        .run(root, scan.fingerprint, summary, JSON.stringify(skipped), Date.now());
    });
  }
  claimInstall(id: string, owner: string) {
    return this.transaction(() => {
      const row: any = this.db.prepare("SELECT pid FROM tooling_locks WHERE id=?").get(id);
      let alive = false;
      if (row) { try { process.kill(row.pid, 0); alive = true; } catch (error: any) { alive = error.code !== "ESRCH"; } }
      if (!alive) this.db.prepare("INSERT INTO tooling_locks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,owner=excluded.owner").run(id, process.pid, owner);
      return !alive;
    });
  }
  releaseInstall(id: string, owner: string) { this.db.prepare("DELETE FROM tooling_locks WHERE id=? AND owner=?").run(id, owner); }
  close() { this.db.close(); }
}
