import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { PiWorker } from "../pi/extensions/orchestrate/rpc.ts";
import { TaskStore } from "../pi/extensions/orchestrate/store.ts";

// Opt-in: uses the existing local Pi login, never copies credentials, and removes
// only this synthetic session's task records, run directories and fixture files.
test("live native routing and coding workers accept independent tasks and produce verified files", { skip: process.env.PI_ORCHESTRATE_LIVE !== "1", timeout: 180000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi live tasks "));
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
  const base = fileURLToPath(new URL("../pi/", import.meta.url)).replace(/\/$/, "");
  const packageDir = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
  const stateDir = join(agentDir, "orchestrator");
  const client = new PiWorker(process.execPath, [join(packageDir, "dist/cli.js"), "--offline", "--mode", "rpc", "--approve", "--no-session", "--no-context-files", "--no-skills", "--no-extensions", "--no-prompt-templates", "--append-system-prompt", join(base, "AGENTS.md"), "-e", join(base, "extensions/orchestrate/index.ts")], root, () => {});
  let session;
  let store;
  t.after(async () => {
    try { await client.request("prompt", { message: "/orchestrate off" }, 10000); } catch {}
    await client.stop();
    if (session && store) {
      const ids = store.list(session).map(task => task.id);
      store.db.prepare("DELETE FROM tasks WHERE session=?").run(session);
      for (const name of await readdir(join(stateDir, "runs")).catch(() => [])) if (ids.some(id => name.startsWith(id + "-"))) await rm(join(stateDir, "runs", name), { recursive: true, force: true });
    }
    store?.close(); await rm(root, { recursive: true, force: true });
  });
  const state = await client.request("get_state", {}, 20000);
  session = state.sessionId;
  assert.equal(typeof session, "string");
  await client.request("prompt", { message: "/orchestrate on" });
  for (const word of ["alpha", "beta"]) await client.request("prompt", { message: `Use project 'current'. Create only ${word}.txt containing exactly '${word}' followed by one newline. This is a disposable file fixture, NOT a Pi configuration change. Verify the file contents and report. Do not access anything outside current, use the network, or commit.` });
  store = new TaskStore(join(stateDir, "tasks.sqlite"));
  const deadline = Date.now() + 140000;
  let tasks;
  while (true) {
    tasks = store.list(session);
    assert.ok(!tasks.some(task => ["failed", "blocked", "waiting"].includes(task.state)), JSON.stringify(tasks.map(task => ({ id: task.id, state: task.state, result: task.result, question: task.question }))));
    if (tasks.length === 2 && tasks.every(task => task.state === "done")) break;
    if (Date.now() > deadline) throw new Error("Live task timeout: " + JSON.stringify(tasks.map(task => ({ id: task.id, state: task.state }))));
    await delay(100);
  }
  assert.notEqual(tasks[0].id, tasks[1].id);
  assert.equal(await readFile(join(root, "alpha.txt"), "utf8"), "alpha\n");
  assert.equal(await readFile(join(root, "beta.txt"), "utf8"), "beta\n");
  assert.ok(tasks.every(task => task.plan.role !== "scout"));
});
