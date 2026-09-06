import { EXTRACTION_PROMPT, parseCandidates } from "./policy.ts";
import type { MemoryStore } from "./store.ts";

// Race explicitly: an uncooperative provider must not hold /reload or quit open.
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); throw new Error("Cancelled"); }
  let listener: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    listener = () => reject(new Error("Cancelled"));
    signal.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", listener!); }
}

export class Learner {
  store: MemoryStore;
  scope: string;
  complete: (system: string, input: string, signal: AbortSignal) => Promise<{ text: string; tokens: number }>;
  idle: () => boolean;
  changed: (error?: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
  running?: Promise<void>;
  closed = false;

  constructor(store: MemoryStore, scope: string, complete: Learner["complete"], idle: () => boolean, changed: Learner["changed"]) {
    this.store = store;
    this.scope = scope;
    this.complete = complete;
    this.idle = idle;
    this.changed = changed;
  }

  wake(delay = 1200) {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.running || !this.idle()) return;
      this.running = this.run().catch(() => { this.notify(true); }).finally(() => { this.running = undefined; });
    }, delay);
    this.timer.unref();
  }

  notify(error = false) { try { this.changed(error); } catch { /* UI may have been disposed. */ } }

  async run() {
    let retry = false;
    try {
      for (let n = 0; n < 3 && !this.closed && this.idle(); n++) {
        const job = this.store.claim(this.scope);
        if (!job) break;
        this.controller = new AbortController();
        const signal = this.controller.signal;
        const deadline = setTimeout(() => this.controller?.abort("timeout"), 60000);
        deadline.unref();
        try {
          const query = job.payload.entries.filter((entry: any) => entry.role === "user").map((entry: any) => entry.text).join("\n");
          const existing = this.store.search(this.scope, query, 12).filter((memory) => memory.scope === this.scope)
            .map(({ topic, text, manual }) => ({ topic, text, manual }));
          const input = JSON.stringify({ conversation: job.payload, existing, blockedTopics: this.store.blocked(this.scope) });
          const output = await abortable(this.complete(EXTRACTION_PROMPT, input, signal), signal);
          if (!this.idle()) this.controller.abort("paused");
          if (signal.aborted || this.closed) throw new Error("Cancelled");
          this.store.finish(job, parseCandidates(output.text, job.payload), output.tokens);
          this.notify();
        } catch {
          const cancelled = signal.aborted && signal.reason !== "timeout";
          this.store.fail(job, cancelled);
          if (!this.closed) this.notify(!cancelled);
          retry = !cancelled;
          break;
        } finally {
          clearTimeout(deadline);
          this.controller = undefined;
        }
      }
    } catch { if (!this.closed) this.notify(true); }
    if (!this.closed && this.idle()) this.wake(retry ? 30000 : 60000);
  }

  pause() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort("paused");
  }

  async close() {
    this.closed = true;
    this.pause();
    await this.running;
  }
}
