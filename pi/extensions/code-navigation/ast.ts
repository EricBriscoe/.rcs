import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { target } from "./state.ts";

export async function structuralSearch(command: string, root: string, params: any, signal?: AbortSignal): Promise<any> {
  const path = await target(root, params.path || ".");
  if (!/^[a-z][a-z0-9_+-]{0,39}$/i.test(params.language || "")) throw new Error("Specify an ast-grep language such as typescript, tsx, python or rust.");
  if (typeof params.pattern !== "string" || !params.pattern.trim() || params.pattern.length > 4000) throw new Error("Provide a structural pattern of 1–4,000 characters.");
  const limit = Math.min(100, Math.max(1, params.limit ?? 30));
  const args = ["run", `--config=${fileURLToPath(new URL("./sgconfig.yml", import.meta.url))}`, "--threads=2", `--lang=${params.language}`, `--pattern=${params.pattern}`, "--json=stream", ...(params.glob ? [`--globs=${params.glob}`] : []), "--", path];
  signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8");
    let buffer = "", stderr = "", failure: Error | undefined, truncated = false;
    const found: any[] = [];
    const stop = () => { child.kill("SIGTERM"); };
    const abort = () => { failure = new Error("Structural search cancelled."); stop(); };
    const timeout = setTimeout(() => { failure = new Error("Structural search timed out; narrow its scope."); stop(); }, 15000);
    // Native ast-grep has no subprocesses; force termination if it resists TERM.
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    child.on("spawn", () => { if (signal?.aborted) abort(); });
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure || truncated) return;
      buffer += decoder.write(chunk);
      if (buffer.length > 1024 * 1024) { failure = new Error("AST match exceeds 1 MB; narrow the pattern."); stop(); return; }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const match = JSON.parse(line);
          if (found.length >= limit) { truncated = true; stop(); break; }
          found.push(match);
        } catch { failure = new Error("Malformed ast-grep output."); stop(); break; }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1000); });
    child.on("error", () => { failure = new Error("Cannot start pinned ast-grep. Retry tooling setup."); });
    signal?.addEventListener("abort", abort, { once: true });
    // An interval avoids a detached timeout outliving a completed search.
    killTimer = setInterval(() => { if (failure || truncated) child.kill("SIGKILL"); }, 500);
    child.on("close", async code => {
      clearTimeout(timeout); clearInterval(killTimer); signal?.removeEventListener("abort", abort);
      if (failure) { reject(failure); return; }
      if (!truncated && (buffer + decoder.end()).trim()) { reject(new Error("Incomplete ast-grep JSON stream.")); return; }
      if (!truncated && code !== 0 && code !== 1) { reject(new Error(`ast-grep failed: ${stderr.slice(0, 500)}`)); return; }
      try {
        const matches = [];
        for (const match of found) {
          const safe = await target(root, resolve(root, match.file));
          matches.push({ path: relative(root, safe), line: match.range?.start.line + 1, byteColumn: match.range?.start.column + 1,
            endLine: match.range?.end.line + 1, text: String(match.text || "").slice(0, 1000) });
        }
        resolveResult({ matches, truncated, coordinates: "1-based lines; byteColumn is a UTF-8 byte offset, NOT an LSP UTF-16 column", note: "Structural matches, not symbol-reference resolution. No rewrites were applied." });
      } catch (error) { reject(error); }
    });
  });
}
