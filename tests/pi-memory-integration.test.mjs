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

async function fixture(t, { trusted = true, history = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi memory integration "));
  const source = join(root, "checkout/pi/extensions/memory");
  const agent = join(root, "agent");
  const project = join(root, "project");
  await mkdir(join(agent, "extensions"), { recursive: true });
  await mkdir(project);
  await cp(new URL("../pi/extensions/memory/", import.meta.url), source, { recursive: true });
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
