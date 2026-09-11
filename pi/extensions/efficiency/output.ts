import { spawn } from "node:child_process";
import { open, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { privateDirectory } from "./usage.ts";

export const MAX_FILTER_BYTES = 2 * 1024 * 1024;
// Classification only: never execute reconstructed argv or alter shell semantics.
export function commandWords(command: string): string[] | undefined {
  if (/^\s*#\s*pi:raw\b/.test(command) || /[\n\r`$<>|;()]/.test(command)) return;
  const words: string[] = []; let word = "", quote = "", started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) { if (c === quote) quote = ""; else word += c; started = true; }
    else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (c === "\\") { if (++i === command.length) return; word += command[i]; started = true; }
    else if (/\s/.test(c)) { if (started) words.push(word); word = ""; started = false; }
    else { word += c; started = true; }
  }
  if (quote) return;
  if (started) words.push(word);
  if (words[0] === "cd" && words[2] === "&&") words.splice(0, 3);
  if (words.some(w => w.includes("&"))) return;
  while (/^[A-Za-z_]\w*=/.test(words[0] || "")) {
    if (words[0] === "RTK_DISABLED=1") return;
    words.shift();
  }
  return words;
}
const diagnostics = (text: string) => /\b(?:\w*warning|fatal|error):|\bWARN\b|\bdeprecated\b|^Traceback\b/im.test(text);
export function filterFor(command: string, raw: string): string | undefined {
  const words = commandWords(command); if (!words?.length) return;
  const [cmd, ...args] = words;
  // Never hide diagnostics or feed structured/machine output into a text filter.
  if (diagnostics(raw) || raw.includes("\0") || args.some(a => /^(?:--json|--format|--pretty|--porcelain=2|--numstat|--name-only|--name-status|--stat|--check|--raw|-z)(?:=|$)/.test(a))) return;
  if (cmd === "git") {
    while (args[0] === "-C" || args[0] === "-c" || args[0] === "--no-pager") args.splice(0, args[0] === "--no-pager" ? 1 : 2);
    if (args[0] === "diff" && /^diff --git /m.test(raw)) return "git-diff";
    if (args[0] === "status" && args.some(a => ["--short", "-s", "--porcelain", "--porcelain=1", "--porcelain=v1"].includes(a)) && !args.some(a => ["-b", "--branch"].includes(a)) && raw.split("\n").filter(Boolean).every(line => /^[ MADRCUT?!]{2} /.test(line))) return "git-status";
  }
  if (cmd === "cargo" && args[0] === "test" && /test result: ok\./.test(raw)) return "cargo-test";
  if ((cmd === "pytest" || /^python[\d.]*$/.test(cmd) && args[0] === "-m" && args[1] === "pytest") && /=+ .*passed/.test(raw)) return "pytest";
  if (cmd === "ctest" && /tests passed, 0 tests failed/.test(raw)) return "ctest";
  if (["vitest", "npx", "pnpm"].includes(cmd) && words.includes("vitest") && /Test Files\s/.test(raw)) return "vitest";
  if (["rg", "grep"].includes(cmd) && !args.some(a => /^--(?:count|files|context|before|after)/.test(a)) && raw.split("\n").filter(Boolean).every(line => /^[^:]+:\d+:/.test(line))) return "grep";
}
// Factor only repeated path prefixes; never cap, deduplicate, reorder or shorten matches.
// Unknown formats (context lines, truncation notices, binary/ANSI output) stay raw.
export function groupedGrep(raw: string): string | undefined {
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(raw)) return;
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const output = ["[Matches grouped by file; line numbers and text unchanged]"];
  let previous: string | undefined;
  for (const line of lines) {
    // Filenames are unescaped: a second numeric delimiter could belong to a path.
    if (line.match(/(?=:\d+:)/g)?.length !== 1) return;
    const match = /^([^:]+):([1-9]\d*):(.*)$/.exec(line);
    if (!match) return;
    const [, file, number, text] = match;
    if (file !== previous) { output.push(`${JSON.stringify(file)}:`); previous = file; }
    output.push(`${number}:${text}`);
  }
  const result = output.join("\n");
  return Buffer.byteLength(result) < Buffer.byteLength(raw) ? result : undefined;
}
export function quietTests(command: string, raw: string): string | undefined {
  const words = commandWords(command); if (!words || diagnostics(raw)) return;
  let pattern: RegExp;
  if (words[0] === "node" && words.includes("--test") && /^ℹ fail 0\s*$/m.test(raw)) pattern = /^\s*✔ .+\([\d.]+m?s\)\s*$/;
  else if (/^python[\d.]*$/.test(words[0]) && words.includes("unittest") && /^OK(?: \(.*\))?\s*$/m.test(raw) && /^Ran \d+ tests? in /m.test(raw)) pattern = /^test\S+ .* \.\.\. ok\s*$/;
  else return;
  let omitted = 0;
  const lines = raw.split("\n").filter(line => { if (pattern.test(line)) { omitted++; return false; } return true; });
  return omitted ? `${lines.join("\n").trim()}\n[${omitted} passing test lines omitted]` : undefined;
}
export async function runFilter(binary: string, filter: string, raw: string, home: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  privateDirectory(home);
  return new Promise((resolve, reject) => {
    // Only RTK sees this isolated HOME/cwd. The original command keeps its real environment.
    const child = spawn(binary, ["pipe", "--filter", filter], { cwd: home, env: {
      PATH: process.env.PATH, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TMPDIR: process.env.TMPDIR,
      HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
      RTK_TELEMETRY_DISABLED: "1", RTK_NO_TOML: "1", RTK_TEE: "0", RTK_DB_PATH: join(home, "rtk.sqlite"),
    }, stdio: ["pipe", "pipe", "pipe"] });
    let output = Buffer.alloc(0), failed = false;
    const stop = () => { failed = true; child.kill("SIGKILL"); };
    const timer = setTimeout(stop, 2000);
    signal.addEventListener("abort", stop, { once: true });
    child.on("spawn", () => { if (signal.aborted) stop(); });
    child.on("error", () => { failed = true; });
    child.stdin.on("error", () => {});
    child.stdout.on("data", chunk => { if (output.length + chunk.length > MAX_FILTER_BYTES) stop(); else output = Buffer.concat([output, chunk]); });
    child.stderr.on("data", chunk => { if (chunk.toString().trim()) failed = true; });
    child.on("close", code => {
      clearTimeout(timer); signal.removeEventListener("abort", stop);
      if (failed || code !== 0) reject(Error("RTK filter unavailable; retain original output."));
      else resolve(output.toString("utf8"));
    });
    child.stdin.end(raw);
  });
}
export const sessionKey = (session: string) => createHash("sha256").update(session).digest("hex").slice(0, 24);
export async function saveRaw(directory: string, text: string) {
  privateDirectory(directory);
  const path = join(directory, `${Date.now()}-${randomUUID()}.log`);
  await writeFile(path, text, { mode: 0o600, flag: "wx" });
  // Only our own generated artifacts, never arbitrary files in an approved read root.
  const files = (await readdir(directory)).filter(name => /^\d+-[a-f0-9-]{36}\.log$/.test(name)).sort();
  await Promise.all(files.slice(0, -100).filter(name => join(directory, name) !== path).map(name => rm(join(directory, name)).catch(() => {})));
  return path;
}
export async function originalOutput(event: any) {
  const text = event.content.map((part: any) => part.type === "text" ? part.text : "").join("\n");
  if (event.details?.fullOutputPath) {
    const file = await open(event.details.fullOutputPath, "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_FILTER_BYTES) return undefined;
      const buffer = Buffer.alloc(MAX_FILTER_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      return size <= MAX_FILTER_BYTES ? { baseline: text, raw: buffer.subarray(0, size).toString("utf8") } : undefined;
    } finally { await file.close(); }
  }
  return Buffer.byteLength(text) <= MAX_FILTER_BYTES ? { baseline: text, raw: text } : undefined;
}
