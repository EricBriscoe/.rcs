import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Use the Pi installation managed by setup-pi.sh, not a separately pinned loader.
const packageDir = join(
  execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
  "@earendil-works/pi-coding-agent",
);
const { clearExtensionCache, loadExtensionsCached } = await import(
  pathToFileURL(join(packageDir, "dist/core/extensions/loader.js")).href
);

async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for monitor delivery after reload.");
    await delay(10);
  }
}

function quote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

async function emit(loaded, type, ctx, reason) {
  for (const handler of loaded.extensions[0].handlers.get(type) ?? []) {
    await handler({ type, reason }, ctx);
  }
}

function execute(loaded, params, ctx) {
  return loaded.extensions[0].tools.get("monitor").definition.execute("test", params, undefined, undefined, ctx);
}

test("Pi reload refreshes monitor helper exports and behavior through the installed symlink layout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi monitor reload "));
  const sourceDir = join(root, "checkout/pi/extensions/monitor");
  const extensionsDir = join(root, "agent/extensions");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(extensionsDir, { recursive: true });
  await symlink(sourceDir, join(extensionsDir, "rcs-monitor"));
  const entryPath = join(extensionsDir, "rcs-monitor/index.ts");
  const entrySource = await readFile(new URL("../pi/extensions/monitor/index.ts", import.meta.url), "utf8");
  const helperName = entrySource.match(/from "\.\/(monitor\.[^"]+)"/)[1];
  const helperSource = await readFile(new URL(`../pi/extensions/monitor/${helperName}`, import.meta.url), "utf8");
  const sent = [];
  const notifications = [];
  const ctx = { cwd: root, isIdle: () => true, ui: { notify: (message) => notifications.push(message) } };
  let loaded;
  t.after(async () => {
    try { if (loaded) await emit(loaded, "session_shutdown", ctx, "quit"); }
    finally {
      clearExtensionCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  async function load(reason) {
    clearExtensionCache();
    loaded = await loadExtensionsCached([entryPath], root);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    loaded.runtime.sendMessage = (message, options) => sent.push({ message, options });
    await emit(loaded, "session_start", ctx, reason);
  }

  // Warm the same process with the older helper that did not export a dispatcher.
  assert.ok(helperSource.includes("export class MonitorDispatcher"));
  await writeFile(join(sourceDir, helperName), helperSource.split("export class MonitorDispatcher")[0]);
  await writeFile(entryPath, `
    import { MonitorManager } from "./${helperName}";
    export default function (pi) {
      const manager = new MonitorManager();
      pi.on("session_start", () => {});
      pi.on("session_shutdown", () => manager.close());
    }
  `);
  await load("startup");
  await emit(loaded, "session_shutdown", ctx, "reload");
  loaded.runtime.invalidate();

  await writeFile(join(sourceDir, helperName), helperSource);
  await writeFile(entryPath, entrySource);
  await load("reload");
  assert.deepEqual((await execute(loaded, { action: "list" }, ctx)).details.monitors, []);
  const definition = loaded.extensions[0].tools.get("monitor").definition;
  assert.deepEqual(definition.parameters.properties.notifyOn.enum, ["output", "completion"]);
  await assert.rejects(execute(loaded, { action: "start", command: "exit 0" }, ctx), /notifyOn is required/);
  assert.deepEqual((await execute(loaded, { action: "list" }, ctx)).details.monitors, []);
  const started = await execute(loaded, {
    action: "start", notifyOn: "output",
    command: `${quote(process.execPath)} -e ${quote("process.stdout.write('ready after reload'); setInterval(() => {}, 1000)")}`,
  }, ctx);
  await waitFor(() => sent.length === 1);
  assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(sent[0].message.customType, "monitor-output");
  assert.deepEqual(sent[0].message.details.monitors[0].chunks, [{ stream: "stdout", text: "ready after reload" }]);

  // A second reload must pick up helper edits, not merely a one-time new filename.
  await emit(loaded, "session_shutdown", ctx, "reload");
  loaded.runtime.invalidate();
  assert.throws(() => process.kill(-started.details.pid, 0), { code: "ESRCH" });
  const changedHelper = helperSource.replace("outputLimit = 16000", "outputLimit = 8");
  assert.notEqual(changedHelper, helperSource);
  await writeFile(join(sourceDir, helperName), changedHelper);
  await load("reload");
  assert.deepEqual((await execute(loaded, { action: "list" }, ctx)).details.monitors, []);
  const gate = join(root, "complete");
  const completion = await execute(loaded, {
    action: "start", notifyOn: "completion",
    command: `${quote(process.execPath)} -e ${quote(`
      const fs = require('node:fs');
      process.stdout.write('0123456789abcdef');
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(gate)})) clearInterval(timer);
      }, 10);
    `)}`,
  }, ctx);
  assert.equal(completion.details.notifyOn, "completion");
  await waitFor(async () => (await execute(loaded, { action: "list" }, ctx)).details.monitors[0].bufferedCharacters === 8);
  await delay(650); // Longer than the automatic batch window: output must not wake Pi.
  assert.equal(sent.length, 1);
  await writeFile(gate, "done");
  await waitFor(() => sent.length === 2);
  const update = sent[1].message.details.monitors[0];
  assert.deepEqual(update.chunks, [{ stream: "stdout", text: "89abcdef" }]);
  assert.equal(update.droppedCharacters, 8);
  assert.equal(update.exitCode, 0);
  assert.equal(update.notifyOn, "completion");
  await emit(loaded, "agent_start", ctx);
  await emit(loaded, "agent_settled", ctx);
  await delay(650);
  assert.equal(sent.length, 2, "Completion should trigger exactly one follow-up.");
  assert.deepEqual(notifications, []);
});
