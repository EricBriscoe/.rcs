import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { MemoryStore } from "../pi/extensions/memory/store.ts";

const packageDir = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const { clearExtensionCache, loadExtensionsCached } = await import(pathToFileURL(join(packageDir, "dist/core/extensions/loader.js")).href);

async function fixture(t, { trusted = true, history = [], embeddingAgent } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi memory integration "));
  const source = join(root, "checkout/pi/extensions/memory");
  const agent = join(root, "agent");
  const project = join(root, "project");
  if (embeddingAgent) {
    const { embeddingHome } = await import('../pi/extensions/memory/embedding-config.mjs');
    await mkdir(join(embeddingHome(agent), '..'), { recursive: true });
    await symlink(embeddingHome(embeddingAgent), embeddingHome(agent));
  }
  await mkdir(join(agent, "extensions"), { recursive: true });
  await mkdir(project);
  await cp(new URL("../pi/extensions/memory/", import.meta.url), source, { recursive: true });
  const efficiency = join(root, "checkout/pi/extensions/efficiency");
  await cp(new URL("../pi/extensions/efficiency/", import.meta.url), efficiency, { recursive: true });
  await symlink(efficiency, join(agent, "extensions/efficiency"));
  await symlink(source, join(agent, "extensions/rcs-memory"));
  const entry = join(agent, "extensions/rcs-memory/index.ts");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  const entries = [...history];
  const notifications = [];
  const views = [];
  const statuses = [];
  const requests = [];
  let loaded;
  let completion = async (_model, context) => {
    const input = JSON.parse(context.messages[0].content[0].text);
    const evidence = input.conversation.entries.find((entry) => entry.role === "user");
    return {
      stopReason: "stop", usage: { totalTokens: 50 }, content: [{ type: "text", text: JSON.stringify({ memories: [{
        topic: "build/package-manager", kind: "feedback", text: "Use pnpm for dependencies in this repository.", keywords: "packages dependencies package manager pnpm npm",
        evidence: [{ entry: evidence.id, quote: "Use pnpm" }],
      }] }) }],
    };
  };
  const ctx = {
    cwd: project, hasUI: true, isIdle: () => true, isProjectTrusted: () => trusted,
    model: { id: "fixture", provider: "fixture" },
    modelRegistry: { complete: async (...args) => { requests.push(args); return completion(...args); } },
    sessionManager: { getBranch: () => entries, getEntries: () => entries, getSessionId: () => "fixture-session" },
    ui: {
      notify: (...args) => notifications.push(args), setStatus: (...args) => statuses.push(args),
      editor: async (_title, text) => { views.push(text); return undefined; }, confirm: async () => true,
    },
  };
  async function emit(type, extra = {}) {
    let result;
    for (const handler of loaded.extensions[0].handlers.get(type) ?? []) result = await handler({ type, ...extra }, ctx) ?? result;
    return result;
  }
  async function load() {
    clearExtensionCache();
    loaded = await loadExtensionsCached([entry], project);
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.sendMessage = (message) => views.push(message.content);
    await emit("session_start", { reason: "startup" });
  }
  t.after(async () => {
    try { if (loaded) await emit("session_shutdown", { reason: "quit" }); }
    finally {
      loaded?.runtime.invalidate(); clearExtensionCache();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
  await load();
  return {
    root, source, agent, entries, ctx, requests, statuses, notifications, views, emit,
    complete: (fn) => { completion = fn; },
    command: (args) => loaded.extensions[0].commands.get("memory").handler(args, ctx),
    tool: (params) => loaded.extensions[0].tools.get("memory").definition.execute("fixture", params, undefined, undefined, ctx),
    reload: async () => { await emit("session_shutdown", { reason: "reload" }); loaded.runtime.invalidate(); await load(); },
  };
}

async function waitFor(predicate) {
  const until = Date.now() + 5000;
  while (!await predicate()) { if (Date.now() > until) throw new Error("Memory operation timed out"); await delay(10); }
}
const user = (id, text) => ({ id, type: "message", message: { role: "user", content: text } });
const assistant = (id, text) => ({ id, type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });

test("native Pi automatically captures, learns, retrieves ephemerally, reloads and forgets", async (t) => {
  const f = await fixture(t);
  f.entries.push(user("u1", "Use pnpm for dependencies in this repo."), assistant("a1", "Understood."));
  await f.emit("agent_settled");
  await waitFor(async () => (await f.tool({ action: "status" })).details.memories === 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0][0], f.ctx.model, "uses configured model/provider, not a hard-coded model");
  assert.equal(f.requests[0][2].maxTokens, 4096);
  assert.equal(f.requests[0][1].tools, undefined, "extractor cannot call tools");
  assert.ok(!f.requests[0][1].messages[0].content[0].text.includes("thinking"));
  const first = (await f.tool({ action: "search", query: "dependencies" })).details[0];
  assert.equal(first.sources[0].entry, "u1");
  const messages = [{ role: "user", content: "Install dependencies", timestamp: 1 }];
  await f.emit("before_agent_start", { prompt: "Install dependencies" });
  let context = await f.emit("context", { messages });
  assert.equal(messages.length, 1, "does not mutate persisted conversation input");
  assert.equal(context.messages[0].customType, "rcs-memory-context");
  assert.equal(context.messages.at(-1).role, "user");
  assert.equal(context.messages.filter((message) => message.customType === "rcs-memory-context").length, 1);
  context = await f.emit("context", { messages: context.messages });
  assert.equal(context.messages.length, 2, "no duplicate injection");

  const helper = join(f.source, "policy.ts");
  await writeFile(helper, (await readFile(helper, "utf8")).replace("Prior-session memory (fallible", "Reloaded memory (fallible"));
  await f.reload();
  assert.equal((await f.tool({ action: "status" })).details.memories, 1);
  await f.emit("before_agent_start", { prompt: "Install dependencies" });
  context = await f.emit("context", { messages });
  assert.match(context.messages[0].content, /Reloaded memory/);
  const toolResult = { role: "toolResult", toolName: "memory", toolCallId: "lookup", timestamp: 1, isError: false,
    content: [{ type: "text", text: JSON.stringify(first) }], details: first };
  await f.command(`forget ${first.id}`);
  const refreshed = await f.emit("context", { messages: [...messages, toolResult] });
  assert.equal(refreshed.messages.at(-1).toolCallId, "lookup", "keep tool response ordering/identity intact");
  assert.ok(!refreshed.messages.at(-1).content[0].text.includes("pnpm"), "old memory tool results are invalidated in active context");
  assert.ok(toolResult.content[0].text.includes("pnpm"), "the original chat is not secretly edited");
  context = await f.emit("context", { messages: context.messages });
  assert.equal(context.messages.length, 1, "forget invalidates active recall too");
  assert.equal((await f.tool({ action: "status" })).details.memories, 0);
  await f.emit("agent_settled");
  assert.equal((await f.tool({ action: "status" })).details.jobs.some((job) => job.state === "pending"), false);
  assert.deepEqual(f.notifications, []);
});

test("controls persist, commands inspect sources, global promotion is user-only, cancellation is not approval", async (t) => {
  const f = await fixture(t);
  await f.command("remember build/tool | Use pnpm for builds. Preserve `a  b` exactly.\nKeep this second line.");
  const local = JSON.parse(f.views.at(-1));
  assert.equal(local.text, "Use pnpm for builds. Preserve `a  b` exactly.\nKeep this second line.");
  await f.command("global remember communication | Keep explanations concise.");
  const global = JSON.parse(f.views.at(-1));
  assert.equal(global.pinned, 1);
  await f.command(`show ${local.id}`);
  assert.ok(Array.isArray(JSON.parse(f.views.at(-1)).history));
  f.ctx.ui.confirm = async () => false;
  await assert.rejects(f.tool({ action: "save", topic: "declined", text: "Do not save this." }), /declined/);
  await assert.rejects(f.tool({ action: "forget", id: local.id }), /declined/);
  await assert.rejects(f.tool({ action: "forget", id: global.id }), /Global memories/);
  f.ctx.hasUI = false;
  await assert.rejects(f.tool({ action: "save", topic: "no-ui", text: "Do not save this." }), /unavailable/);
  f.ctx.hasUI = true;
  await f.command("read off");
  await assert.rejects(f.tool({ action: "search", query: "pnpm" }), /recall is off/);
  await f.command("learn off");
  await f.reload();
  const status = (await f.tool({ action: "status" })).details;
  assert.equal(status.reading, 0);
  assert.equal(status.learning, 0);
  f.entries.push(user("later", "Use pnpm"), assistant("answer", "Noted"));
  await f.emit("agent_settled");
  assert.equal((await f.tool({ action: "status" })).details.jobs.length, 0);
  await f.command("list");
  assert.equal(JSON.parse(f.views.at(-1)).length, 2, "user can still inspect with automatic/tool recall off");
});

test("startup history is not imported and external revocation invalidates unseen current-session evidence", async (t) => {
  const f = await fixture(t, { history: [user("historical", "Use pnpm"), assistant("old-answer", "Understood")] });
  await f.reload();
  await f.emit("agent_settled");
  assert.equal((await f.tool({ action: "status" })).details.jobs.length, 0);
  await f.command("remember build/tool | Use pnpm.");
  const memory = JSON.parse(f.views.at(-1));
  f.entries.push(user("in-flight", "Use pnpm"), assistant("not-yet-captured", "Understood"));
  const outside = new MemoryStore(join(f.agent, "memory/memory.sqlite"));
  try { outside.forget(memory.scope, memory.id); } finally { outside.close(); }
  await f.emit("agent_settled");
  assert.equal((await f.tool({ action: "status" })).details.jobs.length, 0);
});

test("branch navigation cannot import inactive history after forgetting or reload", async (t) => {
  const firstBranch = [user("old-a", "Use pnpm")];
  const secondBranch = [user("old-b", "Use the old configuration")];
  const f = await fixture(t, { history: [...firstBranch, ...secondBranch] });
  f.ctx.sessionManager.getBranch = () => firstBranch;
  await f.reload();
  await f.command("remember build/tool | Use pnpm.");
  const saved = JSON.parse(f.views.at(-1));
  await f.command(`forget ${saved.id}`);
  f.ctx.sessionManager.getBranch = () => secondBranch;
  // Even before the navigation callback, all existing branches are fenced.
  await f.emit("agent_settled");
  assert.equal((await f.tool({ action: "status" })).details.jobs.length, 0);
  await f.emit("session_tree");
  await f.emit("agent_settled");
  assert.equal((await f.tool({ action: "status" })).details.jobs.length, 0);
  f.ctx.sessionManager.getBranch = () => firstBranch;
  await f.reload();
  f.ctx.sessionManager.getBranch = () => secondBranch;
  await f.emit("session_tree");
  await f.emit("agent_settled");
  assert.equal((await f.tool({ action: "status" })).details.jobs.length, 0);
  const fresh = user("fresh", "Use pnpm for the new task.");
  secondBranch.push(fresh);
  f.entries.push(fresh);
  await f.emit("agent_settled");
  const db = new MemoryStore(join(f.agent, "memory/memory.sqlite"));
  try {
    const payload = JSON.parse(db.db.prepare("SELECT payload FROM jobs WHERE payload IS NOT NULL").get().payload);
    assert.deepEqual(payload.entries.map((entry) => entry.id), ["fresh"]);
  } finally { db.close(); }
});

test("another instance re-enabling learning cannot import text written while it was off", async (t) => {
  const f = await fixture(t);
  await f.command("remember build/tool | Use pnpm.");
  const memory = JSON.parse(f.views.at(-1));
  const other = new MemoryStore(join(f.agent, "memory/memory.sqlite"));
  try {
    other.setControl(memory.scope, "learning", false);
    await f.emit("agent_settled"); // Instance A observes the disabled generation.
    f.entries.push(user("private-period", "Use pnpm during sensitive work."));
    other.setControl(memory.scope, "learning", true);
    await f.emit("agent_settled");
    assert.equal((await f.tool({ action: "status" })).details.jobs.length, 0);
    f.entries.push(user("new-allowed", "Use pnpm for normal work."));
    await f.emit("agent_settled");
    const payload = JSON.parse(other.db.prepare("SELECT payload FROM jobs WHERE payload IS NOT NULL").get().payload);
    assert.deepEqual(payload.entries.map((entry) => entry.id), ["new-allowed"]);
  } finally { other.close(); }
});

test("reading off does not stop or cancel independent background learning", async (t) => {
  const f = await fixture(t);
  f.entries.push(user("u1", "Use pnpm"), assistant("a1", "Understood"));
  await f.emit("agent_settled");
  await f.command("read off");
  await waitFor(async () => (await f.tool({ action: "status" })).details.memories === 1);
  assert.equal(f.requests.length, 1);
  await assert.rejects(f.tool({ action: "search", query: "pnpm" }), /recall is off/);
});

test("native reload returns promptly while an extractor ignores its abort signal, then resumes its queue", async (t) => {
  const f = await fixture(t);
  let resolve;
  f.complete(() => new Promise((done) => { resolve = done; }));
  f.entries.push(user("u1", "Use pnpm"), assistant("a1", "Understood"));
  await f.emit("agent_settled");
  await waitFor(() => resolve);
  const started = Date.now();
  await f.reload();
  assert.ok(Date.now() - started < 2000);
  resolve({ stopReason: "stop", content: [{ type: "text", text: '{"memories":[]}' }], usage: { totalTokens: 1 } });
  await delay(5);
  const status = (await f.tool({ action: "status" })).details;
  assert.equal(status.memories, 0);
  assert.equal(status.jobs.find((job) => job.state === "pending").count, 1);
});

test("untrusted projects neither open a memory store nor submit extraction requests", async (t) => {
  const f = await fixture(t, { trusted: false });
  assert.equal(existsSync(join(f.agent, "memory")), false);
  f.entries.push(user("u1", "Use pnpm"));
  await f.emit("agent_settled");
  await f.emit("before_agent_start", { prompt: "Use pnpm" });
  const messages = [{ role: "user", content: "Use pnpm", timestamp: 1 }];
  assert.deepEqual((await f.emit("context", { messages })).messages, messages);
  await assert.rejects(f.tool({ action: "status" }), /untrusted/);
  assert.equal(f.requests.length, 0);
});

test("model changes abort old learning and the next idle batch uses only the newly selected provider/model", async t => {
  const f = await fixture(t);
  let entered;
  f.complete(async (_model, _context, options) => {
    entered = options;
    return new Promise(() => {});
  });
  f.entries.push(user("u1", "Use pnpm for dependencies."));
  await f.emit("agent_settled");
  await waitFor(() => entered);
  f.ctx.model = { provider: "another-fixture", id: "selected-new" };
  await f.emit("model_select", { model: f.ctx.model });
  assert.equal(entered.signal.aborted, true);
  f.complete(async () => ({ stopReason: "stop", usage: { totalTokens: 1 }, content: [{ type: "text", text: '{"memories":[]}' }] }));
  await waitFor(() => f.requests.length === 2);
  assert.equal(f.requests[1][0], f.ctx.model);
  assert.equal(f.requests[1][0].provider, "another-fixture");
  await waitFor(async () => (await f.tool({ action: "status" })).details.jobs.some(j => j.state === "done"));
  assert.ok(f.statuses.some(([, text]) => text?.includes("fallback")));
});

test("machine-local budget command validates settings; tools cannot mutate it", async t => {
  const f = await fixture(t);
  await f.command("budget fallback 5");
  const stats = (await f.tool({ action: "status" })).details;
  assert.equal(stats.budget.fallback, 5);
  await f.command("budget pause 90");
  assert.equal((await f.tool({ action: "status" })).details.budget.pause, 30);
  assert.ok(f.notifications.some(([message]) => message.includes("pause < resume")));
});

for (const code of ["usage_limit_reached", "rate_limit_exceeded"]) {
  test(`stock Codex fallback classifies original structured ${code} without account scraping`, async t => {
    const f = await fixture(t);
    const previousFetch = globalThis.fetch;
    const reset = Math.floor(Date.now() / 1000) + 120;
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { code, resets_at: reset } }), { status: 429 }); };
    t.after(() => { globalThis.fetch = previousFetch; });
    f.ctx.model = { provider: "openai-codex", id: "fixture-codex" };
    await f.emit("model_select", { model: f.ctx.model });
    f.complete(async (_model, _context, options) => {
      assert.equal(options.transport, "sse"); assert.equal(options.maxRetries, 0);
      await options.onPayload({});
      await options.fetch("https://synthetic.invalid", {});
      return { stopReason: "error", errorMessage: "opaque adapter error", usage: { totalTokens: 0 }, content: [] };
    });
    f.entries.push(user("stock-u", "Use pnpm for dependencies."));
    await f.emit("agent_settled");
    await waitFor(() => calls === 1);
    await waitFor(async () => (await f.tool({ action: "status" })).details.jobs.some(j => j.state === "pending"));
    const store = new MemoryStore(join(f.agent, "memory/memory.sqlite"));
    try {
      const job = store.db.prepare("SELECT attempts,ready_at FROM jobs").get();
      assert.equal(job.attempts, code === "usage_limit_reached" ? 0 : 1);
      if (code === "usage_limit_reached") {
        assert.equal(job.ready_at, reset * 1000);
        assert.equal(store.stockQuotaAdmission().nextAt, reset * 1000);
        const scope = store.db.prepare("SELECT scope FROM jobs").get().scope;
        store.enqueue(scope, { session: "second-session", entries: [{ id: "second", role: "user", text: "Use pnpm" }] });
        await f.reload();
        f.entries.push(user("new-after-restart", "Use pnpm for new work."));
        await f.emit("agent_settled");
        await delay(1400);
        assert.equal(calls, 1, "another session and fresh capture remain unsent after restart before stock reset");
        assert.equal(store.db.prepare("SELECT count(*) AS n FROM jobs WHERE payload IS NOT NULL").get().n, 3);
      }
      assert.equal(store.dailyBudget().used, 1);
    } finally { store.close(); }
    assert.equal(f.requests[0][0].provider, "openai-codex");
  });
}

test("agent_settled queues every UTF-8 capture chunk and preserves unqueued evidence after queue pressure", async t => {
  const f = await fixture(t);
  f.ctx.isIdle = () => false;
  const db = new MemoryStore(join(f.agent, "memory/memory.sqlite")); t.after(() => db.close());
  const { projectIdentity } = await import("../pi/extensions/memory/policy.ts");
  const { scope } = await projectIdentity(f.ctx.cwd);
  for (let i = 0; i < 49; i++) db.enqueue(scope, { session: "filler", entries: [{ id: `f${i}`, role: "user", text: `Filler ${i}` }] });
  const request = "界".repeat(5000), answer = "語".repeat(5000);
  f.entries.push(user("large-user", request), assistant("large-assistant", answer));
  await f.emit("agent_settled");
  let queued = db.db.prepare("SELECT payload FROM jobs WHERE session='fixture-session'").all().map(r => JSON.parse(r.payload));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].entries[0].text, request);
  db.db.exec("DELETE FROM jobs WHERE session='filler'");
  await f.emit("agent_settled");
  queued = db.db.prepare("SELECT payload FROM jobs WHERE session='fixture-session' ORDER BY rowid").all().map(r => JSON.parse(r.payload));
  assert.equal(queued.length, 2);
  assert.equal(queued[1].entries.find(e => e.id === "large-assistant").text, answer);
  assert.ok(queued[1].entries.some(e => e.id === "large-user" && e.text.length > 0));
  assert.ok(queued.every(p => Buffer.byteLength(JSON.stringify(p)) <= 28000));
  await f.emit("agent_settled");
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM jobs").get().n, 2);
  assert.equal(f.requests.length, 0);
});

test("returned usage after cancellation keeps immutable submission session and model attribution", async t => {
  const f = await fixture(t);
  let resolve;
  f.complete(() => new Promise(done => { resolve = done; }));
  f.entries.push(user("usage-user", "Use pnpm"));
  await f.emit("agent_settled"); await waitFor(() => resolve);
  f.ctx.model = { provider: "changed", id: "changed" };
  f.ctx.sessionManager.getSessionId = () => "changed-session";
  await f.emit("before_agent_start", { prompt: "foreground" });
  resolve({ stopReason: "aborted", content: [], usage: { input: 7, output: 4, totalTokens: 11 } });
  const { usageReport } = await import("../pi/extensions/efficiency/usage.ts");
  await waitFor(() => usageReport(f.agent, "fixture-session")?.models.length);
  const report = usageReport(f.agent, "fixture-session");
  assert.equal(report.models[0].model, "fixture/fixture");
  assert.equal(report.models[0].total, 11); assert.equal(report.models[0].calls, 1);
  assert.equal(usageReport(f.agent, "changed-session").models.length, 0);
  assert.equal((await f.tool({ action: "status" })).details.memories, 0);
});

test("stock fetch rechecks a shared hold recorded after admission and refunds the unsent reservation", async t => {
  const f = await fixture(t);
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must remain unsent"); };
  t.after(() => { globalThis.fetch = previousFetch; });
  f.ctx.model = { provider: "openai-codex", id: "fixture-codex" };
  await f.emit("model_select", { model: f.ctx.model });
  f.complete(async (_model, _context, options) => {
    const other = new MemoryStore(join(f.agent, "memory/memory.sqlite"));
    try { other.holdStockQuota(Date.now() + 120000); } finally { other.close(); }
    await options.fetch("https://synthetic.invalid", {});
    throw new Error("unreachable");
  });
  f.entries.push(user("held-before-fetch", "Use pnpm")); await f.emit("agent_settled");
  await waitFor(() => f.requests.length === 1);
  await waitFor(async () => (await f.tool({ action: "status" })).details.jobs.some(j => j.state === "pending"));
  const db = new MemoryStore(join(f.agent, "memory/memory.sqlite"));
  try {
    assert.equal(calls, 0); assert.equal(db.dailyBudget().used, 0);
    assert.equal(db.db.prepare("SELECT attempts FROM jobs").get().attempts, 0);
  } finally { db.close(); }
});

test('native memory commands expose retirement and undo; concurrent retirement invalidates active recall', async t => {
  const f = await fixture(t);
  const { projectIdentity, parseCandidates } = await import('../pi/extensions/memory/policy.ts');
  const { scope } = await projectIdentity(f.ctx.cwd);
  const db = new MemoryStore(join(f.agent, 'memory/memory.sqlite'));
  try {
    const make = (topic, text) => ({ topic, text, kind: 'decision', keywords: 'pnpm dependencies', sources: [{ session: 'old', entry: topic, role: 'user', quote: text }] });
    const first = db.save(scope, make('packages', 'Use pnpm for frontend dependencies.'));
    const alias = db.save(scope, make('legacy', 'Keep npm for legacy scripts.'));
    await f.emit('before_agent_start', { prompt: 'pnpm dependencies legacy' });
    const messages = [{ role: 'user', content: 'pnpm dependencies', timestamp: 1 }];
    assert.match((await f.emit('context', { messages })).messages[0].content, new RegExp(alias.id));
    const text = 'Use pnpm for frontend dependencies; keep npm for legacy scripts.';
    const payload = { session: 'fresh', entries: [{ id: 'u', role: 'user', text }] };
    const existing = [first, alias];
    const candidates = parseCandidates(JSON.stringify({ memories: [{ action: 'merge', topic: first.topic, text, kind: 'decision', targets: existing.map(({ id, revision }) => ({ id, revision })), reason: 'User clarified the same dependency policy.', evidence: [{ entry: 'u', quote: text }] }] }), payload, existing);
    db.enqueue(scope, payload); const change = db.finish(db.claim(scope), candidates, 0, existing)[0];
    const refreshed = (await f.emit('context', { messages })).messages[0].content;
    assert.doesNotMatch(refreshed, new RegExp(alias.id)); assert.match(refreshed, /pnpm/);
    await f.command('retired'); assert.equal(JSON.parse(f.views.at(-1))[0].id, alias.id);
    await f.command('changes'); assert.equal(JSON.parse(f.views.at(-1))[0].id, change.changeId);
    await f.reload();
    await f.command(`undo ${change.changeId}`);
    assert.equal(JSON.parse(f.views.at(-1)).undone, change.changeId);
    assert.equal(db.get(scope, alias.id).active, 1); assert.equal(db.get(scope, alias.id).manual, 1);
    assert.equal(db.get(scope, first.id).text, first.text);
    assert.equal((await f.tool({ action: 'status' })).details.retired, 0);
    assert.deepEqual(f.notifications, []);
  } finally { db.close(); }
});

test('installed symlink loads the real local worker and injects semantic recall without persisting it', { skip: !process.env.PI_MEMORY_EMBEDDING_AGENT }, async t => {
  const f = await fixture(t, { embeddingAgent: process.env.PI_MEMORY_EMBEDDING_AGENT });
  await f.command('remember outage | When the service is unavailable, roll back to the last working release.');
  const saved = JSON.parse(f.views.at(-1));
  const db = new MemoryStore(join(f.agent, 'memory/memory.sqlite'));
  try {
    await waitFor(() => db.db.prepare('SELECT count(*) n FROM memory_vectors').get().n === 1);
    const prompt = 'Restore the previous deployment if production goes down.';
    assert.deepEqual(db.search(saved.scope, prompt), []);
    await f.emit('before_agent_start', { prompt });
    const messages = [{ role: 'user', content: prompt, timestamp: 1 }];
    const context = await f.emit('context', { messages });
    assert.equal(context.messages[0].customType, 'rcs-memory-context');
    assert.match(context.messages[0].content, /roll back/);
    assert.equal(f.entries.length, 0);
    assert.equal(f.requests.length, 0);
    assert.match((await f.tool({ action: 'status' })).details.retrieval, /^hybrid/);
    await f.command('read off');
    assert.equal((await f.emit('context', { messages: context.messages })).messages.length, 1);
    await f.command('read on');
    await f.reload();
    assert.equal(db.db.prepare('SELECT count(*) n FROM memory_vectors').get().n, 1);
    await f.command(`forget ${saved.id}`);
    assert.equal(db.db.prepare('SELECT count(*) n FROM memory_vectors').get().n, 0);
    assert.deepEqual(f.notifications, []);
  } finally { db.close(); }
});
