import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { MemoryStore } from "../pi/extensions/memory/store.ts";
import { Learner } from "../pi/extensions/memory/learner.ts";
import { DEFAULT_BUDGET, BackgroundDeferred, admissionText } from "../pi/extensions/memory/budget.ts";
import { memoryQuotaAdmission, createBackgroundQuota } from "../pi/extensions/codex-account-pool/background.mjs";
import { normalizeQuotaPayload, mergeQuotaHeaders } from "../pi/extensions/codex-account-pool/quota.mjs";
import { updatePoolState, readPoolState, markExhausted, noteForegroundAccount } from "../pi/extensions/codex-account-pool/pool.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-budget-"));
  let now = 1_800_000_000_000;
  const path = join(root, "memory.sqlite");
  const store = new MemoryStore(path, () => now);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, now: () => now, tick: ms => now += ms };
}
const payload = (id, session = "s", text = "Use pnpm.") => ({ session, entries: [{ id, role: "user", text }] });
const quota = (now, short = 20, long = 20, allowed = true) => normalizeQuotaPayload({ rate_limit: { allowed, primary_window: { used_percent: short, reset_at: now / 1000 + 3600 }, secondary_window: { used_percent: long, reset_at: now / 1000 + 600000 } }, credits: { unlimited: true, has_credits: true, balance: "999" } }, now);
const account = (id, q) => ({ label: id, accountId: id, enabled: true, access: "synthetic", refresh: "synthetic", expires: 4_000_000_000_000, quota: q });

test("reserve evaluates short AND weekly windows, allowed/exhausted, ignores credits", t => {
  const { now } = fixture(t);
  for (const [short, long, allowed] of [[10, 71, true], [71, 10, true], [10, 10, false]]) {
    const a = account("a", quota(now(), short, long, allowed));
    assert.equal(memoryQuotaAdmission(a, DEFAULT_BUDGET, now()).allowed, false);
    assert.equal(a.memoryReserve, true);
  }
  const q = normalizeQuotaPayload({ rate_limit: { allowed: true, limit_reached: true } }, now());
  assert.equal(memoryQuotaAdmission(account("a", q), DEFAULT_BUDGET, now()).allowed, false);
  assert.equal(memoryQuotaAdmission({ ...account("a", quota(now())), exhausted: true }, DEFAULT_BUDGET, now()).allowed, false);
});

test("30/40 hysteresis persists through missing/stale quota and clears only on trustworthy recovery", t => {
  const { now, tick } = fixture(t);
  const a = account("a", quota(now(), 70, 70));
  assert.equal(memoryQuotaAdmission(a, DEFAULT_BUDGET, now()).allowed, true);
  a.quota = quota(now(), 71, 20);
  assert.equal(memoryQuotaAdmission(a, DEFAULT_BUDGET, now()).allowed, false);
  a.quota = quota(now(), 61, 20);
  assert.equal(memoryQuotaAdmission(a, DEFAULT_BUDGET, now()).allowed, false);
  tick(300000);
  assert.equal(memoryQuotaAdmission(a, DEFAULT_BUDGET, now()).allowed, false);
  delete a.quota;
  assert.equal(memoryQuotaAdmission(a, DEFAULT_BUDGET, now()).allowed, false);
  a.quota = quota(now(), 60, 60);
  assert.equal(memoryQuotaAdmission(a, DEFAULT_BUDGET, now()).mode, "quota");
  assert.equal(a.memoryReserve, false);
  tick(300000);
  assert.equal(memoryQuotaAdmission(a, DEFAULT_BUDGET, now()).mode, "fallback");
});

test("reset deadlines are server-derived and do not imply replenished percentages", t => {
  const { now, tick } = fixture(t);
  const a = account("a", quota(now(), 90, 95));
  const first = memoryQuotaAdmission(a, DEFAULT_BUDGET, now());
  assert.equal(first.nextAt, now() + 600000000);
  tick(600000001);
  assert.equal(memoryQuotaAdmission(a, DEFAULT_BUDGET, now()).allowed, false);
  assert.equal(memoryQuotaAdmission(a, DEFAULT_BUDGET, now()).nextAt, now() + 60000);
});

test("official passive headers merge without losing long-window reserve or rejuvenating omitted data", t => {
  const { now, tick } = fixture(t);
  const previous = quota(now(), 20, 95);
  tick(300001);
  const merged = mergeQuotaHeaders(previous, { "X-Codex-Primary-Used-Percent": "10", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": String(now() / 1000 + 60), "x-codex-credits-unlimited": "true" }, now());
  assert.equal(merged.windows[0].secondary.usedPercent, 95);
  assert.equal(merged.windows[0].fetchedAt, previous.fetchedAt);
  assert.equal(memoryQuotaAdmission(account("a", merged), DEFAULT_BUDGET, now()).allowed, false);
  assert.equal(mergeQuotaHeaders(previous, { "x-codex-credits-unlimited": "true" }), undefined);
  assert.equal(mergeQuotaHeaders(previous, { "x-codex-primary-used-percent": "NaN" }), undefined);
  const extra = mergeQuotaHeaders(undefined, { "x-codex-bengalfox-primary-used-percent": "88" }, now());
  assert.equal(extra.windows[0].limitId, "codex_bengalfox");
});

test("shared quota refresh is current-account only, cooldown bounded, abortable, and read failures preserve auth", async t => {
  const { root, now } = fixture(t);
  const path = join(root, "pool/state.json");
  await updatePoolState(s => { s.enabled = true; s.accounts = [account("a"), account("b")]; }, path);
  let reads = 0;
  const refresh = async id => { reads++; assert.equal(id, "a"); throw new Error("offline"); };
  const service = createBackgroundQuota({ path, now, refresh });
  const signal = new AbortController().signal;
  await Promise.all(Array.from({ length: 8 }, () => service.prepare(DEFAULT_BUDGET, signal, () => true)));
  assert.equal(reads, 1);
  const state = await readPoolState(path);
  assert.equal(state.accounts[0].access, "synthetic");
  assert.equal(state.accounts[0].exhausted, undefined);
  assert.equal(state.accounts[1].memoryRefreshAt, undefined);
  assert.equal((await service.prepare(DEFAULT_BUDGET, signal, () => false)).reason, "working");
  await updatePoolState(s => s.accounts.reverse(), path);
  assert.equal((await service.prepare(DEFAULT_BUDGET, signal, () => true, "a", false)).allowed, false);
  assert.equal(reads, 1);
});

test("compatible jobs batch once, deduplicate IDs and retain source order; sessions/revisions remain separate", t => {
  const { store } = fixture(t);
  store.enqueue("A", payload("u"));
  store.enqueue("A", { session: "s", entries: [payload("u").entries[0], { id: "a", role: "assistant", text: "Accepted." }] });
  store.enqueue("A", payload("u", "other"));
  store.enqueue("A", payload("u", "s", "Use bun."));
  const batch = store.claim("A");
  assert.equal(batch.members.length, 2);
  assert.deepEqual(batch.payload.entries.map(e => e.id), ["u", "a"]);
  assert.equal(store.dailyBudget().used, 1);
  store.finish(batch, [], 55);
  assert.equal(store.stats("A").learningTokens, 55);
  assert.equal(store.claim("A").payload.session, "other");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM jobs WHERE state='pending'").get().n, 1);
});

test("whole jobs that do not fit are not marked done; legacy oversized jobs finish only sent entries", t => {
  const { store } = fixture(t);
  const big = { session: "s", entries: Array.from({ length: 5 }, (_, i) => ({ id: `u${i}`, role: "user", text: "a".repeat(5000) })) };
  store.enqueue("A", big);
  const first = store.claim("A");
  assert.equal(first.payload.entries.length, 3);
  store.finish(first, []);
  const remaining = store.claim("A");
  assert.deepEqual(remaining.payload.entries.map(e => e.id), ["u3", "u4"]);
  store.finish(remaining, []);
  assert.equal(store.stats("A").jobs.find(j => j.state === "done").count, 1);
  assert.equal(store.dailyBudget().used, 2);
});

test("cancelled batch charges once and bounds attempts; proven unsubmitted deferrals refund transactionally", t => {
  const { store } = fixture(t);
  store.enqueue("A", payload("u1")); store.enqueue("A", payload("u2"));
  let batch = store.claim("A");
  store.fail(batch, true, true);
  assert.equal(store.dailyBudget().used, 0);
  assert.equal(store.db.prepare("SELECT sum(attempts) AS n FROM jobs").get().n, 0);
  for (let i = 0; i < 3; i++) { batch = store.claim("A"); store.fail(batch, true); }
  assert.equal(store.dailyBudget().used, 3);
  assert.equal(store.claim("A"), undefined);
  assert.equal(store.stats("A").jobs.find(j => j.state === "failed").count, 2);
});

test("forget, learn-off and lease theft fence every batch member and late completion", t => {
  const { store, path, now, tick } = fixture(t);
  store.enqueue("A", payload("u1")); store.enqueue("A", payload("u2"));
  const first = store.claim("A");
  const other = new MemoryStore(path, now); t.after(() => other.close());
  assert.equal(other.claim("A"), undefined);
  tick(90001);
  const replacement = other.claim("A");
  store.finish(first, []);
  assert.equal(store.stats("A").jobs.find(j => j.state === "running").count, 2);
  const note = store.save("A", { topic: "package", kind: "decision", text: "Use pnpm.", keywords: "", sources: [] }, { manual: true });
  store.forget("A", note.id);
  other.finish(replacement, []);
  assert.equal(store.stats("A").jobs.find(j => j.state === "cancelled").count, 2);
  assert.equal(store.dailyBudget().used, 2);
});

test("global rolling request ceiling transitions conservatively between fallback and quota modes", t => {
  const { store, tick } = fixture(t);
  store.setBudget("fallback", 1); store.setBudget("quota", 2);
  store.enqueue("A", payload("u1")); store.finish(store.claim("A"), []);
  store.enqueue("B", payload("u2"));
  assert.equal(store.claim("B"), undefined);
  store.finish(store.claim("B", "quota"), []);
  store.enqueue("C", payload("u3"));
  assert.equal(store.claim("C", "quota"), undefined);
  assert.equal(store.dailyBudget().used, 2);
  tick(86400000);
  assert.ok(store.claim("C"));
  assert.throws(() => store.setBudget("pause", 40));
  assert.throws(() => store.setBudget("unknown", 1));
});

test("old queue migration keeps payloads, notes and known request expenditure without duplicate migration", t => {
  const { store, path, now } = fixture(t);
  store.enqueue("A", payload("pending"));
  store.enqueue("B", payload("done")); store.finish(store.claim("B"), []);
  store.db.exec("DROP TABLE requests; DROP TABLE budget; PRAGMA user_version=2;");
  const migrated = new MemoryStore(path, now); t.after(() => migrated.close());
  assert.equal(migrated.dailyBudget().used, 1);
  assert.equal(migrated.claim("A").payload.entries[0].id, "pending");
  const again = new MemoryStore(path, now); t.after(() => again.close());
  assert.equal(again.dailyBudget().used, 2);
});

test("simultaneous independent processes atomically reserve the last global request", async t => {
  const { store, path } = fixture(t);
  store.setBudget("fallback", 1);
  store.enqueue("A", payload("a")); store.enqueue("B", payload("b"));
  const url = new URL("../pi/extensions/memory/store.ts", import.meta.url).href;
  const run = scope => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {MemoryStore} from ${JSON.stringify(url)}; const s=new MemoryStore(${JSON.stringify(path)},()=>1800000000000); console.log(Boolean(s.claim(${JSON.stringify(scope)})));s.close();`]);
    let output = ""; child.stdout.on("data", data => output += data);
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error(`child ${code}`)));
  });
  assert.deepEqual((await Promise.all([run("A"), run("B")])).sort(), ["false", "true"]);
  assert.equal(store.dailyBudget().used, 1);
});

test("learner never checks quota with no pending work, exposes deferrals and cleans timers", async t => {
  const { store } = fixture(t);
  let admissions = 0, calls = 0;
  const learner = new Learner(store, "A", async () => { calls++; throw new Error("unexpected"); }, () => true, () => {}, async () => { admissions++; return { allowed: false, mode: "quota", reason: "subscription reserve", nextAt: 1800000000001 }; });
  await learner.run();
  assert.equal(admissions, 0);
  store.enqueue("A", payload("u"));
  await learner.run();
  assert.equal(admissions, 1); assert.equal(calls, 0);
  assert.match(admissionText(learner.admission), /quota.*reserve.*next/);
  assert.equal(store.dailyBudget().used, 0);
  await learner.close(); assert.equal(learner.timer, undefined);
});

test("typed request-routing deferral leaves batch pending without failed attempts", async t => {
  const { store } = fixture(t);
  store.enqueue("A", payload("u"));
  const learner = new Learner(store, "A", async () => { throw new BackgroundDeferred({ allowed: false, mode: "quota", reason: "working" }); }, () => true, () => {});
  await learner.run(); await learner.close();
  assert.equal(store.dailyBudget().used, 0);
  assert.equal(store.stats("A").jobs.find(j => j.state === "pending").count, 1);
});

test("disabled pool means unknown stock identity fallback, not another account's reserve", async t => {
  const { root, now } = fixture(t);
  const path = join(root, "pool/state.json");
  await updatePoolState(s => { s.enabled = false; s.accounts = [{ ...account("a", quota(now(), 99, 99)), memoryReserve: true }]; }, path);
  let reads = 0;
  const service = createBackgroundQuota({ path, now, refresh: async () => { reads++; } });
  const result = await service.prepare(DEFAULT_BUDGET, new AbortController().signal, () => true);
  assert.equal(result.allowed, true); assert.equal(result.mode, "fallback"); assert.equal(result.accountId, undefined); assert.equal(reads, 0);
});

test("submitted quota deferrals stay resumable while still charging each request", async t => {
  const { store, tick } = fixture(t);
  store.enqueue("A", payload("u"));
  const learner = new Learner(store, "A", async () => {
    const error = new BackgroundDeferred({ allowed: false, mode: "quota", reason: "subscription reserve" });
    error.submitted = true; throw error;
  }, () => true, () => {});
  for (let i = 0; i < 4; i++) { await learner.run(); tick(60001); }
  await learner.close();
  assert.equal(store.dailyBudget().used, 4);
  assert.equal(store.stats("A").jobs.find(j => j.state === "pending").count, 1);
  assert.equal(store.db.prepare("SELECT attempts FROM jobs").get().attempts, 0);
});


test("background exhaustion holds repeated wakes and new service instances to A until fresh reset recovery", async t => {
  const { root, now, tick } = fixture(t);
  const path = join(root, "pool/state.json");
  await updatePoolState(s => { s.enabled = true; s.accounts = [account("a", quota(now())), account("b", quota(now()))]; }, path);
  await markExhausted("a", now() + 1000, path, true);
  const options = { path, now, refresh: async () => { throw new Error("offline"); } };
  const signal = new AbortController().signal;
  for (let i = 0; i < 3; i++) {
    const service = createBackgroundQuota(options);
    const admission = await service.prepare(DEFAULT_BUDGET, signal, () => true);
    assert.equal(admission.accountId, "a"); assert.equal(admission.allowed, false);
  }
  tick(300001);
  let service = createBackgroundQuota(options);
  assert.equal((await service.prepare(DEFAULT_BUDGET, signal, () => true)).allowed, false, "expired exhaustion with stale quota is not permission to drain B");
  await updatePoolState(s => { s.accounts[0].quota = quota(now()); }, path);
  const recovered = await service.prepare(DEFAULT_BUDGET, signal, () => true);
  assert.equal(recovered.accountId, "a"); assert.equal(recovered.allowed, true);
  assert.equal((await readPoolState(path)).backgroundHoldAccountId, undefined);
  await markExhausted("a", now() + 1000, path, true);
  await noteForegroundAccount("a", path);
  assert.equal((await readPoolState(path)).backgroundHoldAccountId, "a");
  await noteForegroundAccount("b", path);
  assert.equal((await readPoolState(path)).backgroundHoldAccountId, undefined);
  assert.equal((await service.prepare(DEFAULT_BUDGET, signal, () => true)).accountId, "b");
});


test("confirmed stock quota reset backoff survives restart, then queued extraction succeeds", async t => {
  const { store, path, now, tick } = fixture(t);
  store.enqueue("A", payload("u"));
  const reset = now() + 120000;
  const learner = new Learner(store, "A", async () => {
    const error = new BackgroundDeferred({ allowed: false, mode: "fallback", reason: "subscription quota", nextAt: reset });
    error.submitted = true; throw error;
  }, () => true, () => {});
  await learner.run(); await learner.close();
  const restarted = new MemoryStore(path, now); t.after(() => restarted.close());
  assert.equal(restarted.nextReadyAt("A"), reset);
  assert.equal(restarted.claim("A"), undefined);
  assert.equal(restarted.stats("A").batches, 1);
  tick(120000);
  let calls = 0;
  const next = new Learner(restarted, "A", async () => { calls++; return { text: '{"memories":[]}', tokens: 2 }; }, () => true, () => {});
  await next.run(); await next.close();
  assert.equal(calls, 1);
  assert.equal(restarted.dailyBudget().used, 2);
  assert.equal(restarted.stats("A").jobs.find(j => j.state === "done").count, 1);
});

test("stock-route quota hold is shared by scopes, sessions and newly enqueued work across restart", async t => {
  const { store, path, now, tick } = fixture(t);
  store.enqueue("A", payload("a", "one"));
  store.enqueue("A", payload("b", "two"));
  const reset = now() + 120000;
  let calls = 0;
  const run = async (db, scope) => {
    const learner = new Learner(db, scope, async () => { calls++; db.holdStockQuota(reset); const error = new BackgroundDeferred(db.stockQuotaAdmission()); error.submitted = true; throw error; }, () => true, () => {}, async () => db.stockQuotaAdmission() ?? { allowed: true, mode: "fallback" });
    await learner.run(); await learner.close();
  };
  await run(store, "A");
  store.enqueue("B", payload("new", "three"));
  const restarted = new MemoryStore(path, now); t.after(() => restarted.close());
  await run(restarted, "A"); await run(restarted, "B");
  assert.equal(calls, 1);
  assert.equal(restarted.dailyBudget().used, 1);
  assert.equal(restarted.db.prepare("SELECT count(*) AS n FROM jobs WHERE payload IS NOT NULL AND state='pending'").get().n, 3);
  tick(120000);
  assert.equal(restarted.stockQuotaAdmission(), undefined);
});

test("short-reset recovery rejects pre-exhaustion cache and requires post-reset telemetry", async t => {
  const { root, now, tick } = fixture(t);
  const path = join(root, "pool/state.json");
  await updatePoolState(s => { s.enabled = true; s.accounts = [account("a", quota(now())), account("b", quota(now()))]; }, path);
  tick(1);
  await markExhausted("a", now() + 1000, path, true, now());
  tick(1001);
  let reads = 0;
  const service = createBackgroundQuota({ path, now, refresh: async () => { reads++; } });
  const signal = new AbortController().signal;
  assert.equal((await service.prepare(DEFAULT_BUDGET, signal, () => true)).allowed, false);
  assert.equal(reads, 1, "refresh is needed even though cached quota is less than five minutes old");
  assert.equal((await readPoolState(path)).backgroundHoldAccountId, "a");
  await updatePoolState(s => { s.accounts[0].quota = quota(now()); }, path);
  assert.equal((await service.prepare(DEFAULT_BUDGET, signal, () => true)).allowed, true);
  assert.equal((await readPoolState(path)).accounts[0].exhausted, false);
});

test("unknown-reset exhaustion refreshes with bounded cooldown and accepts affirmative subsequent recovery", async t => {
  const { root, now, tick } = fixture(t);
  const path = join(root, "pool/state.json");
  await updatePoolState(s => { s.enabled = true; s.accounts = [account("a", quota(now())), account("b", quota(now()))]; }, path);
  tick(1); await markExhausted("a", undefined, path, true, now());
  let reads = 0;
  const service = createBackgroundQuota({ path, now, refresh: async id => {
    reads++; assert.equal(id, "a");
    if (reads > 1) await updatePoolState(s => { s.accounts[0].quota = quota(now()); }, path);
  } });
  const signal = new AbortController().signal;
  for (let i = 0; i < 3; i++) {
    const admission = await service.prepare(DEFAULT_BUDGET, signal, () => true);
    assert.equal(admission.allowed, false); assert.equal(admission.nextAt, now() + 60000);
  }
  assert.equal(reads, 1);
  tick(60000);
  const recovered = await service.prepare(DEFAULT_BUDGET, signal, () => true);
  assert.equal(recovered.accountId, "a"); assert.equal(recovered.allowed, true); assert.equal(reads, 2);
  assert.equal((await readPoolState(path)).backgroundHoldAccountId, undefined);
});

test("legacy recently claimed requests count despite old creation and older failure timestamps", t => {
  const { store, path, now, tick } = fixture(t);
  store.enqueue("A", payload("old-no-finish")); store.enqueue("B", payload("old-failure"));
  tick(2 * 86400000);
  store.db.prepare("UPDATE jobs SET attempts=2,state='running',lease_until=?,finished_at=CASE WHEN scope='B' THEN created_at+1000 ELSE NULL END").run(now() + 90000);
  store.db.exec("DROP TABLE requests; PRAGMA user_version=2;");
  const migrated = new MemoryStore(path, now); t.after(() => migrated.close());
  assert.equal(migrated.dailyBudget().used, 4);
  assert.deepEqual(migrated.db.prepare("SELECT DISTINCT reserved_at FROM requests").all().map(r => r.reserved_at), [now()]);
  migrated.setBudget("fallback", 4);
  migrated.enqueue("C", payload("new"));
  assert.equal(migrated.claim("C"), undefined);
});

test("learner restart reconciles its only expired final-attempt lease before checking pending work", async t => {
  const { store, path, now, tick } = fixture(t);
  store.enqueue("A", payload("stranded"));
  for (let i = 0; i < 3; i++) { store.claim("A"); tick(90001); }
  const restarted = new MemoryStore(path, now); t.after(() => restarted.close());
  let calls = 0, admissions = 0;
  const learner = new Learner(restarted, "A", async () => { calls++; return { text: '{"memories":[]}', tokens: 0 }; }, () => true, () => {}, async () => { admissions++; return { allowed: true, mode: "fallback" }; });
  await learner.run();
  assert.equal(restarted.stats("A").jobs.find(j => j.state === "failed").count, 1);
  assert.equal(admissions, 0); assert.equal(calls, 0);
  restarted.retry("A"); await learner.run(); await learner.close();
  assert.equal(calls, 1); assert.equal(restarted.stats("A").jobs.find(j => j.state === "done").count, 1);
});
