import { BackgroundDeferred } from "./budget.ts";
import type { Admission } from "./budget.ts";
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

export type LearningOutcome = { at: number; proposed: number; saved: number; skipped: Record<string, number> };

export class Learner {
  store: MemoryStore;
  scope: string;
  complete: (system: string, input: string, signal: AbortSignal, admission?: Admission, onDeferred?: (error: BackgroundDeferred) => void) => Promise<{ text: string; tokens: number }>;
  idle: () => boolean;
  changed: (error?: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
  running?: Promise<void>;
  closed = false;
  admission?: Admission;
  lastOutcome?: LearningOutcome;
  admit: (signal: AbortSignal) => Promise<Admission>;

  constructor(store: MemoryStore, scope: string, complete: Learner["complete"], idle: () => boolean, changed: Learner["changed"], admit: Learner["admit"] = async () => ({ allowed: true, mode: "fallback" })) {
    this.store = store;
    this.scope = scope;
    this.complete = complete;
    this.idle = idle;
    this.changed = changed;
    this.admit = admit;
  }

  wake(delay = 1200) {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.running) { this.wake(delay); return; }
      if (!this.idle()) return;
      this.running = this.run().catch(() => { this.notify(true); }).finally(() => { this.running = undefined; });
    }, delay);
    this.timer.unref();
  }

  notify(error = false) { try { this.changed(error); } catch { /* UI may have been disposed. */ } }

  async run() {
    let retry = false;
    try {
      this.store.maintain();
      for (let n = 0; n < 3 && !this.closed && this.idle(); n++) {
        this.store.expireJobs();
        if (!this.store.hasPending(this.scope)) {
          const nextAt = this.store.nextReadyAt(this.scope);
          if (nextAt) { this.admission = { allowed: false, mode: this.admission?.mode ?? "fallback", reason: "queued backoff", nextAt }; this.notify(); }
          break;
        }
        const controller = new AbortController();
        this.controller = controller;
        const signal = controller.signal;
        const deadline = setTimeout(() => controller.abort("timeout"), 60000);
        let job: any;
        let submissionDeferral: BackgroundDeferred | undefined;
        deadline.unref();
        try {
          this.admission = await abortable(this.admit(signal), signal);
          if (!this.admission.allowed || signal.aborted || !this.idle()) { this.notify(); break; }
          job = this.store.claim(this.scope, this.admission.mode);
          if (!job) {
            const daily = this.store.dailyBudget(this.admission.mode);
            this.admission = { ...this.admission, allowed: false, reason: daily.nextAt ? "daily budget" : "queue leased or unavailable", nextAt: daily.nextAt };
            this.notify(); break;
          }
          this.notify();
          const query = job.payload.entries.filter((entry: any) => entry.role === "user").map((entry: any) => entry.text).join("\n");
          const existing = (await this.store.candidates(this.scope, query, 12, { purpose: 'learning', signal, allowed: () => !this.closed && this.idle() && this.store.liveBatch(job) })).filter((memory) => memory.scope === this.scope)
            .map(({ id, revision, topic, kind, text, keywords, sources, manual, pinned, evidence_at }) => ({ id, revision, topic, kind, text, keywords, sources, manual, pinned, evidence_at }));
          // Evidence is never trimmed here. Optional dedup context yields to the JSON cap;
          // tombstones are also enforced transactionally on every proposed save.
          const data = { conversation: job.payload, existing, blockedTopics: this.store.blocked(this.scope) };
          while (Buffer.byteLength(JSON.stringify(data)) > 30000 && data.existing.length) data.existing.pop();
          while (Buffer.byteLength(JSON.stringify(data)) > 30000 && data.blockedTopics.length) data.blockedTopics.pop();
          const input = JSON.stringify(data);
          if (signal.aborted || this.closed || !this.idle() || !this.store.liveBatch(job))
            throw new BackgroundDeferred({ allowed: false, mode: this.admission.mode, reason: 'working' });
          if (Buffer.byteLength(input) > 30000) throw new Error("Extraction JSON exceeds budget.");
          const output = await abortable(this.complete(EXTRACTION_PROMPT, input, signal, this.admission, error => { submissionDeferral ??= error; }), signal);
          if (!this.idle()) controller.abort("paused");
          if (signal.aborted || this.closed) throw new Error("Cancelled");
          if (Buffer.byteLength(output.text) > 30000) throw new Error("Extraction output exceeds budget.");
          const candidates = parseCandidates(output.text, job.payload, data.existing);
          // Do not label a revoked/invalidated batch as a successful empty extraction.
          if (this.store.liveBatch(job)) {
            const results = this.store.finish(job, candidates, output.tokens, data.existing);
            const skipped: Record<string, number> = {};
            for (const result of results) if (result.skipped) skipped[result.skipped] = (skipped[result.skipped] ?? 0) + 1;
            this.lastOutcome = { at: Date.now(), proposed: candidates.length, saved: results.filter(result => !result.skipped).length, skipped };
          }
          this.notify();
        } catch (error) {
          // Classification is published before asynchronous pool persistence; abort may win that wait.
          const failure = submissionDeferral ?? error;
          const deferred = failure instanceof BackgroundDeferred ? failure : undefined;
          if (deferred) this.admission = deferred.admission;
          const cancelled = !!deferred || (signal.aborted && signal.reason !== "timeout");
          if (job) this.store.fail(job, cancelled, !!deferred && !deferred.submitted, !!deferred, deferred?.admission.nextAt);
          if (!this.closed) this.notify(!cancelled);
          retry = !cancelled;
          break;
        } finally {
          clearTimeout(deadline);
          this.controller = undefined;
        }
      }
    } catch { if (!this.closed) this.notify(true); }
    if (!this.closed && this.idle() && !this.timer) this.wake(retry ? 30000 : 60000);
  }

  pause() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort("paused");
    this.admission = { allowed: false, mode: this.admission?.mode ?? "fallback", reason: "working" };
  }

  async close() {
    this.closed = true;
    this.pause();
    await this.running;
  }
}
