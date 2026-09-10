import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { capture, GLOBAL_SCOPE, memoryContext, parseCandidates, projectIdentity, redact, searchTerms, topicKey } from "../pi/extensions/memory/policy.ts";
import { Learner, abortable } from "../pi/extensions/memory/learner.ts";
import { MemoryStore } from "../pi/extensions/memory/store.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi memory test "));
  let time = 100000000;
  const path = join(root, "memory.sqlite");
  const store = new MemoryStore(path, () => time);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, path, root, tick: (ms = 1) => { time += ms; } };
}
const note = (text = "Use pnpm for this repository.", topic = "build/package-manager") => ({
  topic, text, kind: "decision", keywords: "dependencies packages package manager pnpm npm", sources: [{ session: "session", entry: "u1", role: "user", quote: "Use pnpm" }],
});
const payload = (session = "session", entry = "u1") => ({ session, entries: [{ id: entry, role: "user", text: "Use pnpm for this repository." }] });
const extraction = (entry = "u1") => JSON.stringify({ memories: [{ ...note(), sources: undefined, evidence: [{ entry, quote: "Use pnpm" }] }] });
const user = (id, text) => ({ id, type: "message", message: { role: "user", content: text } });
const assistant = (id, text) => ({ id, type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });

async function waitFor(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw new Error("Timed out"); await delay(5); }
}

test("SQLite permissions, persistence, FTS ranking, synonyms, zero irrelevant recall", (t) => {
  const { store, path, root } = fixture(t);
  const saved = store.save("A", note());
  store.save("A", note("Reload local TypeScript helpers instead of native ESM caching.", "pi/reload"));
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const file of [path + "-wal", path + "-shm"]) assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(store.search("A", "pnpm")[0].id, saved.id);
  assert.equal(store.search("A", "install dependencies").length, 2);
  assert.deepEqual(store.recall("A", "watermelon gardening"), []);
  assert.deepEqual(store.search("A", '" OR * NEAR()'), []);
  const reopened = new MemoryStore(path);
  try { assert.equal(reopened.get("A", saved.id).text, saved.text); } finally { reopened.close(); }
});

test("recall survives inflection and an extractor paraphrasing away the original query vocabulary", (t) => {
  const { store } = fixture(t);
  const evidence = { session: "s", entries: [{ id: "u1", role: "user", text: "Use pnpm to install dependencies in this repository." }] };
  const response = JSON.stringify({ memories: [{ topic: "build/package-manager", kind: "feedback", text: "The accepted package manager here is pnpm.", keywords: "package manager pnpm",
    evidence: [{ entry: "u1", quote: "Use pnpm" }] }] });
  const candidate = parseCandidates(response, evidence)[0];
  assert.match(candidate.keywords, /dependencies/);
  const saved = store.save("A", candidate);
  assert.equal(store.search("A", "dependencies")[0].id, saved.id);
  assert.equal(store.search("A", "dependency")[0].id, saved.id);
  assert.deepEqual(store.search("A", "gardening"), []);
});

test("the stemming-index migration preserves canonical data and rebuilds existing search entries", (t) => {
  const { store, path } = fixture(t);
  const saved = store.save("A", { ...note("Use pnpm for dependency installation."), keywords: "" }, { manual: true });
  store.db.exec(`DROP TRIGGER memory_insert; DROP TRIGGER memory_update; DROP TRIGGER memory_delete; DROP TABLE memory_fts;
    CREATE VIRTUAL TABLE memory_fts USING fts5(topic,keywords,text,content='memories',content_rowid='rowid');
    INSERT INTO memory_fts(memory_fts) VALUES('rebuild'); PRAGMA user_version=1;`);
  assert.deepEqual(store.search("A", "dependencies"), []);
  const migrated = new MemoryStore(path);
  try {
    assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 5);
    assert.equal(migrated.search("A", "dependencies")[0].id, saved.id);
    assert.equal(migrated.get("A", saved.id).manual, 1);
    migrated.forget("A", saved.id);
    assert.deepEqual(migrated.search("A", "dependencies"), []);
  } finally { migrated.close(); }
});

test("project boundaries apply to search, direct ID, history, pins, listing and writes", (t) => {
  const { store } = fixture(t);
  const privateNote = store.save("B", note("Employer database procedure.", "database"), { manual: true, pinned: true });
  const global = store.save(GLOBAL_SCOPE, note("Use accessible explanations.", "communication"), { manual: true, pinned: true });
  assert.deepEqual(store.search("A", "Employer"), []);
  assert.throws(() => store.get("A", privateNote.id, true), /not found/);
  assert.throws(() => store.pin("A", privateNote.id, true), /not found/);
  assert.throws(() => store.forget("A", privateNote.id), /not found/);
  assert.throws(() => store.forget("A", global.id), /global command/);
  assert.throws(() => store.save(GLOBAL_SCOPE, note()), /explicit user/);
  assert.deepEqual(store.list("A").map((memory) => memory.id), [global.id]);
  assert.deepEqual(store.recall("A", "database").map((memory) => memory.id), [global.id]);
  store.setControl("A", "reading", false);
  assert.deepEqual(store.recall("A", "accessible"), []);
});

test("stable topics supersede rather than duplicate, preserve provenance, and protect manual corrections", (t) => {
  const { store, tick } = fixture(t);
  const first = store.save("A", note());
  tick();
  const changed = store.save("A", note("Use bun for this repository."));
  assert.equal(changed.id, first.id);
  assert.equal(store.get("A", first.id, true).history[0].text, first.text);
  assert.equal(store.list("A").length, 1);
  store.save("A", note("Use yarn for this repository."), { manual: true });
  assert.equal(store.save("A", note()).skipped, "manual");
  assert.match(store.get("A", first.id).text, /yarn/);
  assert.equal(store.save("A", note("Use yarn for this repository.", "duplicate")).skipped, "duplicate");
});

test("forget removes all versions/index entries and blocks old and in-flight resurrection", (t) => {
  const { store } = fixture(t);
  const saved = store.save("A", note());
  for (let i = 0; i < 15; i++) store.save("A", note(`Historical preference number ${i}.`));
  store.enqueue("A", payload());
  const job = store.claim("A");
  store.forget("A", saved.id);
  assert.deepEqual(store.finish(job, [note()]), []);
  assert.deepEqual(store.search("A", "pnpm historical"), []);
  assert.throws(() => store.get("A", saved.id, true), /not found/);
  assert.equal(store.db.prepare("SELECT count(*) n FROM versions").get().n, 0);
  assert.equal(store.db.prepare("SELECT count(*) n FROM jobs WHERE payload IS NOT NULL").get().n, 0);
  assert.equal(store.save("A", note()).skipped, "revoked");
  assert.equal(store.save("A", note("Historical preference number 0.", "renamed")).skipped, "revoked");
  assert.equal(store.enqueue("A", payload()), false, "job receipt survives forgetting");
  assert.equal(store.save("A", note(), { manual: true }).skipped, "revoked");
  assert.ok(store.save("A", note(), { manual: true, restore: true }).id);
});

test("global revocation cancels learning in other processes/scopes and blocks project copies", (t) => {
  const { store, path } = fixture(t);
  const global = store.save(GLOBAL_SCOPE, note(), { manual: true });
  store.enqueue("A", payload());
  const job = store.claim("A");
  const other = new MemoryStore(path);
  try { other.forget(GLOBAL_SCOPE, global.id); } finally { other.close(); }
  assert.deepEqual(store.finish(job, [note()]), []);
  assert.equal(store.save("A", note()).skipped, "revoked");
  assert.deepEqual(store.blocked("A"), [note().topic]);
});

test("global forgetting removes existing exact copies and historical copies but preserves distinct policies", (t) => {
  const { store } = fixture(t);
  const global = store.save(GLOBAL_SCOPE, note(), { manual: true });
  const copy = store.save("A", note(), { manual: true, pinned: true });
  const renamed = store.save("B", note(note().text, "renamed"));
  const changed = store.save("C", note());
  store.save("C", note("Use bun for this repository."));
  store.forget(GLOBAL_SCOPE, global.id);
  assert.throws(() => store.get("A", copy.id), /not found/);
  assert.throws(() => store.get("B", renamed.id), /not found/);
  assert.deepEqual(store.list("A"), []);
  assert.deepEqual(store.recall("A", "pnpm"), []);
  assert.deepEqual(store.search("B", "pnpm"), []);
  assert.match(store.get("C", changed.id).text, /bun/);
  assert.deepEqual(store.get("C", changed.id, true).history, []);
});

test("enqueue rejects evidence captured before a concurrent project or global revocation", (t) => {
  const { store } = fixture(t);
  const saved = store.save("A", note());
  const before = store.generation("A");
  store.forget("A", saved.id);
  assert.equal(store.enqueue("A", payload(), before), false);
  assert.equal(store.stats("A").jobs.length, 0);
  const global = store.save(GLOBAL_SCOPE, note("Use short explanations.", "communication"), { manual: true });
  const next = store.generation("A");
  store.forget(GLOBAL_SCOPE, global.id);
  assert.equal(store.enqueue("A", payload("different"), next), false);
  assert.equal(store.stats("A").jobs.length, 0);
});

test("durable jobs deduplicate, lease by project, recover from crashes and fence late workers", (t) => {
  const { store, path, tick } = fixture(t);
  assert.equal(store.enqueue("A", payload()), true);
  assert.equal(store.enqueue("A", payload()), false);
  store.enqueue("A", payload("second", "u2"));
  const first = store.claim("A");
  const other = new MemoryStore(path, store.now);
  try {
    assert.equal(other.claim("A"), undefined);
    tick(90001);
    const recovered = other.claim("A");
    assert.equal(recovered.id, first.id);
    assert.notEqual(recovered.owner, first.owner);
    assert.deepEqual(store.finish(first, [note()]), []);
    assert.equal(other.finish(recovered, [note()], 100).length, 1);
    assert.equal(other.claim("A").payload.session, "second");
    assert.equal(store.stats("A").learningTokens, 100);
  } finally { other.close(); }
});

test("older retried evidence cannot overwrite a newer correction", (t) => {
  const { store, tick } = fixture(t);
  store.enqueue("A", payload());
  const older = store.claim("A");
  store.fail(older, false);
  // Same-millisecond checkpoints still need deterministic evidence ordering.
  store.enqueue("A", payload("new", "u2"));
  const newer = store.claim("A");
  store.finish(newer, [note("Use bun for this repository.")]);
  tick(30000);
  const retried = store.claim("A");
  assert.equal(store.finish(retried, [note()])[0].skipped, "stale");
  assert.match(store.list("A")[0].text, /bun/);
});

test("learning off discards pending data, fences active jobs and stays off after reopening", (t) => {
  const { store, path } = fixture(t);
  store.enqueue("A", payload());
  const job = store.claim("A");
  store.setControl("A", "learning", false);
  assert.deepEqual(store.finish(job, [note()]), []);
  assert.equal(store.enqueue("A", payload("later")), false);
  assert.equal(store.claim("A"), undefined);
  assert.equal(store.db.prepare("SELECT payload FROM jobs").get().payload, null);
  const other = new MemoryStore(path);
  try { assert.equal(other.control("A").learning, 0); } finally { other.close(); }
});

test("failed jobs have bounded retries, sensitive queue retention, and an explicit retry", (t) => {
  const { store, tick } = fixture(t);
  store.enqueue("A", payload());
  for (let attempt = 1; attempt <= 3; attempt++) {
    const job = store.claim("A");
    assert.equal(job.attempts, attempt);
    store.fail(job, false);
    tick(120000);
  }
  assert.equal(store.claim("A"), undefined);
  assert.equal(store.stats("A").jobs[0].state, "failed");
  store.retry("A");
  assert.equal(store.claim("A").attempts, 1);
  tick(8 * 86400000);
  assert.equal(store.claim("A"), undefined);
  assert.equal(store.db.prepare("SELECT payload FROM jobs").get().payload, null);
});

test("a crash on the last lease attempt becomes an explicitly retryable failure", (t) => {
  const { store, tick } = fixture(t);
  store.enqueue("A", payload());
  for (let n = 1; n <= 3; n++) {
    assert.equal(store.claim("A").attempts, n);
    tick(90001);
  }
  assert.equal(store.claim("A"), undefined);
  assert.equal(store.stats("A").jobs[0].state, "failed");
  store.retry("A");
  assert.equal(store.claim("A").attempts, 1);
});

test("the rolling learning job budget stops additional requests", (t) => {
  const { store, tick } = fixture(t);
  for (let i = 0; i < 20; i++) {
    store.enqueue("A", payload(`session${i}`));
    store.finish(store.claim("A"), []);
  }
  store.enqueue("A", payload("over-budget"));
  assert.equal(store.claim("A"), undefined);
  tick(86400001);
  assert.ok(store.claim("A"));
});

test("redaction runs before capture; no tools, files, thinking, old history or injected memory are learned", () => {
  const credentials = [
    '<private>private phrase</private>', 'password="my password"', 'API_KEY=not-for-memory',
    'https://user:password@example.test', 'Bearer abcdefghijklmnopqrstuvwxyz',
    'sk-proj-abcdefghijklmnopqrstuvwxyz', 'ghp_abcdefghijklmnopqrstuvwxyz',
    '-----BEGIN PRIVATE KEY-----\nabcdef\n-----END PRIVATE KEY-----',
  ];
  for (const credential of credentials) assert.notEqual(redact(credential), credential);
  const entries = [
    user("old", "Do not import this old preference."),
    user("u1", "Use pnpm. <private>super private</private> API_KEY=hidden-value"),
    { id: "tool", type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "secret file contents" }] } },
    { id: "thought", type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "hidden reasoning" }] } },
    { id: "memory", type: "custom_message", customType: "rcs-memory-context", content: "old remembered preference" },
    assistant("a1", "I used pnpm."),
  ];
  const [result] = capture(entries, new Set(["old"]), "session", new Set(["old"]));
  assert.deepEqual(result.entries.map((entry) => entry.id), ["u1", "a1"]);
  const text = JSON.stringify(result);
  for (const secret of ["hidden-value", "super private", "secret file contents", "hidden reasoning", "old preference"]) assert.ok(!text.includes(secret));
  assert.deepEqual(capture(entries, new Set(entries.map((entry) => entry.id)), "session"), []);
});

test("capture always reserves user evidence and respects both text and escaped-JSON budgets", () => {
  const entries = [user("u1", '"'.repeat(5000)), ...Array.from({ length: 4 }, (_, i) => assistant(`a${i}`, '"'.repeat(5000)))];
  const [captured] = capture(entries, new Set(), "session");
  assert.ok(captured.entries.some((entry) => entry.id === "u1"));
  assert.ok(captured.entries.reduce((n, entry) => n + entry.text.length, 0) <= 18000);
  assert.ok(JSON.stringify(captured).length <= 30000);
});

test("topic keys cannot bypass secret filtering, including embedded token prefixes", (t) => {
  const { store } = fixture(t);
  for (const topic of ["sk-proj-abcdefghijklmnopqrstuvwxyz", "prefix_sk-proj-abcdefghijklmnopqrstuvwxyz"]) {
    assert.throws(() => topicKey(topic), /private/);
    assert.throws(() => store.save("A", note("Innocent text.", topic)), /private/);
    assert.throws(() => parseCandidates(extraction().replace("build/package-manager", topic), payload()), /private/);
  }
  assert.equal(store.list("A").length, 0);
});

test("compaction checkpoints reuse the task request but never cross a revocation/startup baseline", () => {
  const entries = [user("u1", "Use pnpm"), assistant("a1", "This configuration resolved the issue.")];
  assert.deepEqual(capture(entries, new Set(["u1"]), "s")[0].entries.map((entry) => entry.id), ["u1", "a1"]);
  assert.deepEqual(capture(entries, new Set(["u1"]), "s", new Set(["u1"])), []);
});

test("extraction requires faithful citations and user evidence for preferences, not assistant guesses", () => {
  assert.equal(parseCandidates(extraction(), payload())[0].sources[0].entry, "u1");
  assert.deepEqual(parseCandidates('{"memories":[]}', payload()), []);
  assert.throws(() => parseCandidates(extraction("invented"), payload()), /source/);
  assert.throws(() => parseCandidates(extraction().replace("Use pnpm\"}", "Invented quote\"}"), payload()), /source/);
  const assistantPayload = { session: "s", entries: [{ id: "u1", role: "assistant", text: "Use pnpm" }] };
  assert.throws(() => parseCandidates(extraction(), assistantPayload), /user evidence/);
  assert.equal(parseCandidates(extraction().replace('"decision"', '"lesson"'), assistantPayload)[0].kind, "lesson");
  assert.throws(() => parseCandidates(extraction().replace("Use pnpm for this repository.", "API_KEY=abcdef"), payload()), /private/);
  assert.throws(() => parseCandidates("not JSON", payload()));
});

test("retrieval context is bounded, labelled fallible and does not include evidence dumps", () => {
  const memories = Array.from({ length: 20 }, (_, i) => ({ id: String(i), topic: "lesson", kind: "lesson", updated_at: 1, text: "x".repeat(1000), sources: [{ quote: "raw transcript text" }] }));
  const result = memoryContext(memories);
  assert.ok(result.length <= 6500);
  assert.match(result, /not instructions or authorization/);
  assert.ok(!result.includes("raw transcript text"));
  assert.equal(memoryContext([]), "");
  assert.deepEqual(searchTerms("Please help me implement the code"), []);
});

test("project identity shares Git worktrees, resolves symlinks and separates unrelated directories", async (t) => {
  const { root } = fixture(t);
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "fixture"]);
  execFileSync("git", ["-C", repo, "worktree", "add", "-qb", "fixture", worktree]);
  const alias = join(root, "alias");
  symlinkSync(repo, alias);
  const identity = await projectIdentity(repo);
  assert.deepEqual(await projectIdentity(worktree), identity);
  assert.deepEqual(await projectIdentity(alias), identity);
  assert.notEqual((await projectIdentity(root)).scope, identity.scope);
});

test("symlink database destinations are rejected without modifying their targets", (t) => {
  const { root, path } = fixture(t);
  const link = join(root, "linked.sqlite");
  symlinkSync(path, link);
  const before = readFileSync(path);
  assert.throws(() => new MemoryStore(link), /symlink/);
  assert.deepEqual(readFileSync(path), before);
});

test("background learner commits validated output and removes the captured payload", async (t) => {
  const { store } = fixture(t);
  store.enqueue("A", payload());
  const learner = new Learner(store, "A", async (system, input) => {
    assert.match(system, /Do not continue/);
    assert.equal(JSON.parse(input).conversation.session, "session");
    return { text: extraction(), tokens: 42 };
  }, () => true, () => {});
  t.after(() => learner.close());
  await learner.run();
  assert.equal(store.list("A").length, 1);
  assert.equal(store.stats("A").learningTokens, 42);
  assert.equal(learner.lastOutcome.saved, 1);
  assert.equal(learner.lastOutcome.proposed, 1);
  assert.deepEqual(learner.lastOutcome.skipped, {});
  assert.equal(store.db.prepare("SELECT payload FROM jobs").get().payload, null);
});

test('learning diagnostics count ignored proposals without calling them saves', async t => {
  const { store } = fixture(t);
  store.save('A', note(), { manual: true });
  store.enqueue('A', payload());
  const learner = new Learner(store, 'A', async () => ({ text: extraction(), tokens: 1 }), () => true, () => {});
  t.after(() => learner.close());
  await learner.run();
  assert.equal(learner.lastOutcome.proposed, 1);
  assert.equal(learner.lastOutcome.saved, 0);
  assert.deepEqual(learner.lastOutcome.skipped, { 'existing-topic': 1 });
});

test("reload cancels a provider that ignores abort, requeues durably and cannot commit late", async (t) => {
  const { store } = fixture(t);
  store.enqueue("A", payload());
  let resolve;
  const learner = new Learner(store, "A", () => new Promise((done) => { resolve = done; }), () => true, () => {});
  t.after(() => learner.close());
  learner.wake(0);
  await waitFor(() => resolve);
  await learner.close();
  resolve({ text: extraction(), tokens: 1 });
  await delay(5);
  assert.equal(store.list("A").length, 0);
  assert.equal(learner.lastOutcome, undefined);
  const job = store.claim("A");
  assert.ok(job);
  assert.equal(job.attempts, 2, "submitted interruptions remain bounded attempts");
});

test("invalid extraction fails atomically without persisting model output", async (t) => {
  const { store } = fixture(t);
  store.enqueue("A", payload());
  const learner = new Learner(store, "A", async () => ({ text: "password=should-not-be-stored", tokens: 1 }), () => true, () => {});
  t.after(() => learner.close());
  await learner.run();
  assert.equal(store.list("A").length, 0);
  assert.ok(!JSON.stringify(store.db.prepare("SELECT * FROM jobs").all()).includes("should-not-be-stored"));
  assert.equal(learner.lastOutcome, undefined);
});

test("abortable handles cancellation without waiting for a hung provider", async () => {
  const controller = new AbortController();
  const waiting = abortable(new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(waiting, /Cancelled/);
});
