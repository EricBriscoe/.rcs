import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const exec = promisify(execFile);

// Parse RTK's canonical `config` output, not arbitrary user TOML. Unsupported
// serialization fails closed rather than accidentally writing a different DB.
export function trackingPath(config: string, env = process.env, platform = process.platform): string | undefined {
  const tracking = config.split(/^\[tracking\]\r?\n/m)[1]?.split(/^\[/m)[0];
  if (!tracking || !/^enabled = (true|false)$/m.test(tracking)) throw Error("RTK tracking config unavailable");
  if (/^enabled = false$/m.test(tracking)) return;
  if (env.RTK_DB_PATH !== undefined) return resolve(env.RTK_DB_PATH);
  const value = /^database_path = (.+)$/m.exec(tracking)?.[1];
  if (value !== undefined) {
    const path = /^'[^'\r\n]*'$/.test(value) ? value.slice(1, -1) : JSON.parse(value);
    if (typeof path !== "string") throw Error("Invalid RTK database path");
    return resolve(path);
  }
  const home = env.HOME || homedir();
  const data = platform === "darwin" ? join(home, "Library/Application Support")
    : platform === "win32" ? env.LOCALAPPDATA
    : env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local/share");
  if (!data) throw Error("RTK data directory unavailable");
  return join(data, "rtk/history.db");
}

function checkDatabaseFiles(path: string, required = false) {
  for (const file of [path, path + "-wal", path + "-shm"]) {
    try { if (!lstatSync(file).isFile()) throw Error("RTK database must be a regular file"); }
    catch (error: any) { if ((required && file === path) || error.code !== "ENOENT") throw error; }
  }
}

/** RTK pipe has no tracking API. Let RTK own schema/config; append only accepted
 * Pi reductions with its byte/4 estimate. No raw command, output or replay. */
export function gainRecorder(binary: () => string) {
  let ready: Promise<string | undefined> | undefined;
  async function initialize(signal: AbortSignal) {
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA,
      RTK_DB_PATH: process.env.RTK_DB_PATH, RTK_TELEMETRY_DISABLED: "1",
    };
    const options = { env, signal, timeout: 2000, maxBuffer: 128 * 1024 };
    const { stdout } = await exec(binary(), ["config"], options);
    const path = trackingPath(stdout, env);
    if (path) {
      checkDatabaseFiles(path);
      // Native initialization/migrations only; gain does not record a command.
      await exec(binary(), ["gain", "--format", "json"], { ...options, env: { ...env, RTK_DB_PATH: path } });
    }
    return path;
  }
  return async (filter: string, before: number, after: number, cwd: string, signal: AbortSignal): Promise<boolean> => {
    let db: DatabaseSync | undefined;
    try {
      if (!/^(rtk:(git-diff|git-status|cargo-test|pytest|ctest|vitest)|passing-tests|grouped-grep)$/.test(filter)
        || !Number.isSafeInteger(before) || !Number.isSafeInteger(after) || after < 0 || before <= after) return true;
      signal.throwIfAborted();
      ready ??= initialize(signal).catch(error => { ready = undefined; throw error; });
      const path = await ready;
      if (!path) return true; // Respect tracking.enabled=false.
      signal.throwIfAborted();
      checkDatabaseFiles(path, true);
      db = new DatabaseSync(path);
      db.exec("PRAGMA busy_timeout=100");
      const input = Math.ceil(before / 4), output = Math.ceil(after / 4), saved = input - output;
      db.prepare(`INSERT INTO commands
        (timestamp,original_cmd,rtk_cmd,project_path,input_tokens,output_tokens,saved_tokens,savings_pct,exec_time_ms)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(
        new Date().toISOString(), "pi tool output", `pi ${filter}`, realpathSync(cwd), input, output, saved, saved / input * 100, 0,
      );
      return true;
    } catch { return false; } // Accounting must not discard a successful reduction.
    finally { try { db?.close(); } catch { /* Best effort, including shutdown. */ } }
  };
}
