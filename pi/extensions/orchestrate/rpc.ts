import { spawn, execFile } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { redact } from "../memory/policy.ts";

export class PiWorker {
  child: any;
  buffer = "";
  decoder = new StringDecoder("utf8");
  nextId = 0;
  requests = new Map<string, any>();
  exited = false;
  stopping = false;
  lastText = "";
  lastStop = "";
  lastError = "";
  usage = { input: 0, output: 0, total: 0 };
  toolCount = 0;
  settled?: () => void;
  failed?: (error: Error) => void;
  completion: Promise<any>;
  closePromise: Promise<void>;
  onQuestion: (request: any) => void;
  onEvent: (event: any) => void;
  stderr = "";
  constructor(command: string, args: string[], cwd: string, onQuestion: PiWorker["onQuestion"], onEvent: PiWorker["onEvent"] = () => {}, env: NodeJS.ProcessEnv = process.env) {
    this.onQuestion = onQuestion;
    this.onEvent = onEvent;
    this.completion = new Promise((resolve, reject) => { this.settled = () => resolve({ text: this.lastText, usage: this.usage, tools: this.toolCount }); this.failed = reject; });
    // An exit before run() is called must not become an unhandled rejection.
    void this.completion.catch(() => {});
    this.child = spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.closePromise = new Promise(resolve => this.child.once("close", () => resolve()));
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(this.decoder.write(chunk)));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-2000); });
    this.child.stdin.on("error", () => {});
    this.child.on("error", () => this.fail(new Error("Could not start the Pi worker.")));
    this.child.on("close", () => {
      this.exited = true;
      this.fail(new Error(this.stopping ? "Worker stopped; partial changes were retained." : "Pi worker exited before reporting completion."));
    });
  }
  consume(chunk: string) {
    this.buffer += chunk;
    // Preserve LF framing and Unicode separators inside JSON strings.
    if (this.buffer.length > 4 * 1024 * 1024) { this.fail(new Error("Worker protocol record exceeded 4 MB.")); void this.stop(); return; }
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { this.event(JSON.parse(line)); } catch { this.fail(new Error("Invalid worker protocol output.")); void this.stop(); }
    }
  }
  event(event: any) {
    if (event.type === "response") {
      const pending = this.requests.get(event.id);
      if (pending) {
        this.requests.delete(event.id);
        clearTimeout(pending.timer);
        event.success ? pending.resolve(event.data) : pending.reject(new Error(`Worker rejected ${event.command}.`));
      }
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      this.usage.input += message.usage?.input ?? 0;
      this.usage.output += message.usage?.output ?? 0;
      this.usage.total += message.usage?.totalTokens ?? ["input", "output", "cacheRead", "cacheWrite"].reduce((sum, key) => sum + (message.usage?.[key] ?? 0), 0);
      this.lastText = (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n").slice(-18000);
      this.lastStop = message.stopReason;
      this.lastError = typeof message.errorMessage === "string" ? redact(message.errorMessage).slice(0, 500) : "";
    } else if (event.type === "agent_settled") {
      if (["error", "aborted", "length"].includes(this.lastStop)) this.fail(new Error(`Worker model request failed or did not complete normally.${this.lastError ? " " + this.lastError : ""}`));
      else if (!this.lastText.trim()) this.fail(new Error("Worker returned no result."));
      else this.settled?.();
    } else if (event.type === "tool_execution_start") {
      this.toolCount++;
      if (this.toolCount > 100) { this.fail(new Error("Worker exceeded 100 tool calls.")); void this.stop(); }
    } else if (event.type === "extension_ui_request" && ["input", "confirm", "select", "editor"].includes(event.method)) {
      this.onQuestion(event);
    }
    this.onEvent(event);
  }
  fail(error: Error) {
    this.failed?.(error);
    for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.requests.clear();
  }
  request(type: string, params: any = {}, timeout = 10000): Promise<any> {
    if (this.exited || !this.child.stdin.writable) return Promise.reject(new Error("Worker is not running."));
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error(`Worker ${type} timed out.`)); }, timeout);
      this.requests.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, type, ...params }) + "\n");
    });
  }
  reply(request: any, text: string) {
    if (!text.trim()) throw new Error("An empty reply is not an answer.");
    let answer: any = { type: "extension_ui_response", id: request.id };
    if (request.method === "confirm") {
      if (!/^(yes|no)$/i.test(text.trim())) throw new Error("Reply yes or no to this confirmation.");
      answer.confirmed = /^yes$/i.test(text.trim());
    } else if (request.method === "select") {
      if (!request.options?.includes(text)) throw new Error("Reply with one of the displayed choices.");
      answer.value = text;
    } else answer.value = text;
    this.child.stdin.write(JSON.stringify(answer) + "\n");
  }
  async run(prompt: string, timeoutMs: number, signal: AbortSignal) {
    const abort = () => { this.fail(new Error("Task paused or cancelled; inspect partial changes before resuming.")); void this.stop(); };
    signal.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(() => { this.fail(new Error("Task time limit reached; partial changes were retained.")); void this.stop(); }, timeoutMs);
    try {
      signal.throwIfAborted();
      await this.request("prompt", { message: prompt }, 20000);
      return await this.completion;
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
      await this.stop();
    }
  }
  stoppingPromise?: Promise<void>;
  stop() {
    if (!this.stoppingPromise) this.stoppingPromise = this.stopInside();
    return this.stoppingPromise;
  }
  async stopInside() {
    if (this.exited) return;
    this.stopping = true;
    // Clear queued continuations first: RPC abort alone can continue them.
    const descendants = await childPids(this.child.pid);
    try { await this.request("clear_queue", {}, 500); await this.request("abort", {}, 1500); } catch { /* Escalate below. */ }
    const kill = (signal: NodeJS.Signals) => {
      // Built-in shell tools may own separate process groups. Only signal PIDs
      // observed as this worker's descendants, never arbitrary system processes.
      for (const pid of [...descendants].reverse()) { try { process.kill(pid, signal); } catch {} }
      try { process.kill(-this.child.pid, signal); } catch {}
    };
    kill("SIGTERM");
    await Promise.race([this.closePromise, delay(500)]);
    // Sending TERM is not proof of exit; also finish TERM-resistant descendants.
    kill("SIGKILL");
    await this.closePromise;
  }
}

async function childPids(root: number): Promise<number[]> {
  if (!root) return [];
  try {
    const { stdout } = await promisify(execFile)("ps", ["-axo", "pid=,ppid="], { timeout: 1000, maxBuffer: 2 * 1024 * 1024 });
    const rows = stdout.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
    const found = new Set([root]);
    let changed = true;
    while (changed) { changed = false; for (const [pid, parent] of rows) if (found.has(parent) && !found.has(pid)) { found.add(pid); changed = true; } }
    found.delete(root);
    return [...found];
  } catch { return []; }
}
