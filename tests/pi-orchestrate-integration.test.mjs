import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { PiWorker } from "../pi/extensions/orchestrate/rpc.ts";
import { profile, workerArgs } from "../pi/extensions/orchestrate/profiles.ts";

const packageDir = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const { clearExtensionCache, loadExtensionsCached } = await import(pathToFileURL(join(packageDir, "dist/core/extensions/loader.js")).href);
const nativeBase = fileURLToPath(new URL("../pi/", import.meta.url)).replace(/\/$/, "");
const plan = { title: "Clarify target", role: "scout", project: "current", brief: "Wait for the user to specify the repository.", dependencies: [], question: "Which repository?" };
async function waitFor(check) {
  const deadline = Date.now() + 15000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out"); await delay(10); }
}

async function fixture(t, trusted = true) {
  const root = await mkdtemp(join(tmpdir(), "pi orchestration integration "));
  const base = join(root, "checkout/pi");
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  await cp(nativeBase, base, { recursive: true });
  await mkdir(agent); await mkdir(cwd);
  await symlink(join(base, "settings.json"), join(agent, "settings.json"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  const notifications = [], messages = [], requests = [];
  const model = { id: "fixture", provider: "fixture", api: "fixture" };
  const ctx = {
    cwd, hasUI: true, model, isProjectTrusted: () => trusted, isIdle: () => true, waitForIdle: async () => {},
    sessionManager: { getSessionId: () => "fixture-session" },
    modelRegistry: { getAvailable: () => [model], complete: async (...args) => { requests.push(args); return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(plan) }] }; } },
    ui: { notify: (...args) => notifications.push(args), setWidget: () => {}, setStatus: () => {}, setEditorText: () => {}, editor: async () => undefined },
  };
  let loaded;
  async function emit(type, extra = {}) {
    let result;
    for (const handler of loaded.extensions[0].handlers.get(type) ?? []) result = await handler({ type, ...extra }, ctx) ?? result;
    return result;
  }
  async function load() {
    clearExtensionCache();
    loaded = await loadExtensionsCached([join(base, "extensions/orchestrate/index.ts")], cwd);
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.sendMessage = message => messages.push(message);
    await emit("session_start");
    assert.ok(!notifications.some(([message]) => message.includes("unavailable:")), JSON.stringify(notifications));
  }
  t.after(async () => {
    try { if (loaded) await emit("session_shutdown"); }
    finally {
      loaded?.runtime.invalidate(); clearExtensionCache();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
  await load();
  return { root, agent, cwd, ctx, requests, messages, notifications, emit,
    command: args => loaded.extensions[0].commands.get("orchestrate").handler(args, ctx),
    reload: async () => { await emit("session_shutdown"); loaded.runtime.invalidate(); await load(); },
  };
}

test("native Pi extension handles intake without main-model turns and reloads in OFF mode", async t => {
  const f = await fixture(t);
  assert.equal((await f.emit("input", { text: "ordinary task", source: "interactive" })).action, "continue");
  assert.equal(f.requests.length, 0);
  await f.command("on");
  assert.equal((await f.emit("input", { text: "Fix the project configuration", source: "interactive" })).action, "handled");
  assert.ok(f.messages.some(message => /Queued #1/.test(message.content)));
  await waitFor(() => f.messages.some(message => /#1 blocked/.test(message.content)));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0][1].tools, undefined);
  assert.equal(f.requests[0][2].maxTokens, 2048);
  assert.equal((await f.emit("input", { text: "internal follow-up", source: "extension" })).action, "continue");
  assert.deepEqual(await f.emit("session_before_compact"), { cancel: true });
  const user = { role: "user", content: "normal follow-up" };
  const messages = [user, { role: "custom", customType: "orchestrate-status", content: "different-project result" }];
  assert.deepEqual((await f.emit("context", { messages })).messages, [user]);
  assert.equal(messages.length, 2, "task history remains intact while model context is filtered");
  await f.reload();
  assert.equal((await f.emit("input", { text: "normal mode again", source: "interactive" })).action, "continue");
  await f.command("show 1");
  assert.equal(f.requests.length, 1, "reload does not resume planner or workers");
});

test("untrusted sessions cannot enable orchestration or create task state", async t => {
  const f = await fixture(t, false);
  await f.command("on");
  assert.ok(f.notifications.some(([text]) => /trusted session/.test(text)));
  assert.equal(existsSync(join(f.agent, "orchestrator/tasks.sqlite")), false);
});

test("role selection stays in authenticated configured profiles with explicit current-model fallback", () => {
  const selected = { provider: "native", id: "small" };
  const config = { roles: { scout: { provider: "native", model: "small", thinking: "low" } } };
  assert.equal(profile(config, "scout", { modelRegistry: { getAvailable: () => [selected] } }).model, selected);
  const fallback = { provider: "native", id: "strong" };
  assert.equal(profile(config, "scout", { modelRegistry: { getAvailable: () => [] }, model: fallback }).fallback, true);
  assert.throws(() => profile(config, "scout", { modelRegistry: { getAvailable: () => [] } }), /authenticated/);
});

test("real RPC worker loads only approved tools and relays actual native input dialogs without a model call", { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi worker protocol "));
  const agent = join(root, "agent"), cwd = join(root, "project");
  await mkdir(agent); await mkdir(cwd);
  const output = join(root, "result.json"), prompt = join(root, "prompt.txt"), probe = join(root, "probe.ts");
  await writeFile(prompt, "NATIVE_WORKER_CONTEXT");
  await writeFile(join(cwd, "AGENTS.md"), "FOREIGN_ANCESTOR_WORKER_CONTEXT");
  await writeFile(probe, `import {writeFileSync} from 'node:fs'; export default function(pi){pi.registerCommand('probe',{description:'fixture',handler:async(_args,ctx)=>{const answer=await ctx.ui.input('Native question','Choose a real answer'); writeFileSync(${JSON.stringify(output)},JSON.stringify({answer,tools:pi.getActiveTools(),prompt:ctx.getSystemPrompt()}));}});}`);
  const args = workerArgs(nativeBase, packageDir, { model: { provider: "openai", id: "gpt-4o" }, thinking: "off" }, prompt, true);
  assert.ok(!args.some(arg => /memory\/index|orchestrate\/index|\.codex|\.claude/.test(arg)));
  args.push("-e", probe);
  let worker;
  worker = new PiWorker(process.execPath, args, cwd, request => worker.reply(request, "explicit answer"), undefined, { ...process.env, PI_CODING_AGENT_DIR: agent, PI_ORCHESTRATOR_CHILD: "1", PI_TASK_READ_ONLY: "true" });
  t.after(async () => { await worker.stop(); await rm(root, { recursive: true, force: true }); });
  await worker.request("prompt", { message: "/probe" }, 20000);
  await waitFor(() => existsSync(output));
  const result = JSON.parse(await readFile(output, "utf8"));
  assert.equal(result.answer, "explicit answer");
  for (const tool of ["task_question", "read", "web_search", "web_browse"]) assert.ok(result.tools.includes(tool));
  for (const tool of ["bash", "edit", "write", "memory", "monitor"]) assert.ok(!result.tools.includes(tool));
  assert.match(result.prompt, /NATIVE_WORKER_CONTEXT/);
  assert.doesNotMatch(result.prompt, /FOREIGN_ANCESTOR_WORKER_CONTEXT|\.agents\/skills/);
});

test("native worker file guard blocks escapes, symlinks and scout form interactions", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi worker guard "));
  const cwd = join(root, "project"); await mkdir(cwd);
  const outside = join(root, "outside"); await writeFile(outside, "private fixture"); await symlink(outside, join(cwd, "escape"));
  const previous = process.env.PI_TASK_READ_ONLY;
  process.env.PI_TASK_READ_ONLY = "true";
  clearExtensionCache();
  const loaded = await loadExtensionsCached([join(nativeBase, "extensions/orchestrate/worker.ts")], cwd);
  t.after(async () => { loaded.runtime.invalidate(); clearExtensionCache(); if (previous === undefined) delete process.env.PI_TASK_READ_ONLY; else process.env.PI_TASK_READ_ONLY = previous; await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(loaded.errors, []);
  const handler = loaded.extensions[0].handlers.get("tool_call")[0];
  for (const path of [outside, join(cwd, "escape"), "../outside"]) assert.equal((await handler({ toolName: "read", input: { path } }, { cwd })).block, true);
  assert.equal(await handler({ toolName: "read", input: { path: "new.txt" } }, { cwd }), undefined);
  assert.equal((await handler({ toolName: "write", input: { path: "new.txt" } }, { cwd })).block, true);
  assert.equal((await handler({ toolName: "web_browse", input: { action: "click" } }, { cwd })).block, true);
  process.env.PI_TASK_READ_ONLY = "false";
  assert.equal((await handler({ toolName: "write", input: { path: ".git/config" } }, { cwd })).block, true);
});
