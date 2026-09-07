import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// LSP's byte-counted Content-Length protocol, not Pi's JSONL RPC protocol.
export class LspClient {
  child: any;
  pending = new Map<number, any>();
  next = 0;
  buffer = Buffer.alloc(0);
  closed = false;
  didExit = false;
  closing?: Promise<void>;
  exited: Promise<void>;
  stderr = "";
  onRequest: (method: string, params: any) => any;
  constructor(command: string[], cwd: string, onRequest: LspClient["onRequest"] = () => undefined) {
    this.onRequest = onRequest;
    this.child = spawn(command[0], command.slice(1), { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise(resolve => this.child.once("close", () => {
      this.didExit = true;
      // Stop same-group helpers promptly, never signal an old PID on later reuse.
      if (this.child.pid) { try { process.kill(-this.child.pid, "SIGKILL"); } catch {} }
      this.fail(new Error("Language server exited. Retry navigation to restart it.")); resolve();
    }));
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-2000); });
    this.child.stdin.on("error", () => {});
    this.child.on("error", () => this.fail(new Error("Could not start language server. Check its configured executable.")));
  }
  consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) { if (this.buffer.length > 8192) throw new Error("Invalid LSP header."); return; }
        if (end > 8192) throw new Error("LSP header too large.");
        const header = this.buffer.subarray(0, end).toString("ascii");
        const lengths = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
        if (lengths.length !== 1) throw new Error("Missing or duplicate LSP Content-Length.");
        const size = Number(lengths[0][1]);
        if (size < 1 || size > 8 * 1024 * 1024) throw new Error("LSP response exceeds 8 MB; narrow the query.");
        if (this.buffer.length < end + 4 + size) return;
        const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + size).toString("utf8"));
        this.buffer = this.buffer.subarray(end + 4 + size);
        if (message.jsonrpc !== "2.0") throw new Error("Invalid LSP JSON-RPC response.");
        if (message.method && message.id !== undefined) {
          // No execution/edit application or filesystem access on server requests.
          let result;
          try { result = this.onRequest(message.method, message.params); } catch { result = undefined; }
          this.send(result === undefined
            ? { id: message.id, error: { code: -32601, message: "Client method unsupported; no edits applied." } }
            : { id: message.id, result });
        } else if (!message.method && message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (pending) {
            pending.cleanup(); this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(`LSP request failed (${message.error.code}): ${String(message.error.message).slice(0, 400)}`));
            else pending.resolve(message.result);
          }
        }
      }
    } catch (error: any) { this.fail(error); void this.close(); }
  }
  send(message: any) {
    if (this.closed || !this.child.stdin.writable) throw new Error("Language server is closed.");
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  notify(method: string, params?: any) { this.send({ method, ...(params === undefined ? {} : { params }) }); }
  request(method: string, params: any, signal?: AbortSignal, timeout = 20000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Language server is closed."));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const cancel = (error: Error) => {
        if (!this.pending.has(id)) return;
        cleanup(); this.pending.delete(id);
        try { this.notify("$/cancelRequest", { id }); } catch {}
        reject(error);
      };
      const aborted = () => cancel(new Error("LSP request cancelled."));
      const timer = setTimeout(() => cancel(new Error(`LSP ${method} timed out.`)), timeout);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      try { this.send({ id, method, params }); }
      catch (error) { cleanup(); this.pending.delete(id); reject(error); }
    });
  }
  fail(error: Error) {
    this.closed = true;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
  }
  close(): Promise<void> { return this.closing ??= this.stop(); }
  async stop() {
    if (this.didExit) return;
    if (!this.closed) {
      try { await this.request("shutdown", null, undefined, 500); this.notify("exit"); } catch {}
    }
    this.fail(new Error("Language server stopped."));
    const kill = (signal: NodeJS.Signals) => { if (this.child.pid && !this.didExit) { try { process.kill(-this.child.pid, signal); } catch {} } };
    kill("SIGTERM");
    await Promise.race([this.exited, delay(300)]);
    kill("SIGKILL");
    await this.exited;
  }
}
