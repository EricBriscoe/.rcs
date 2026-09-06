import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Orchestrator, parsePlan } from "../pi/extensions/orchestrate/engine.ts";
import { TaskStore } from "../pi/extensions/orchestrate/store.ts";
import { PiWorker } from "../pi/extensions/orchestrate/rpc.ts";

const plan = (project = "a", dependencies = []) => ({ title: "Fixture task", project, role: "worker", brief: "Inspect the fixture and report the result.", dependencies, question: null });
const finishable = signal => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out"); await delay(5); }
}
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi orchestrate "));
  const path = join(root, "tasks.sqlite");
  const store = new TaskStore(path);
  const engine = new Orchestrator(store, "session", {
    projects: () => ({ a: "/project/a", b: "/project/b" }),
    resource: async path => path,
    plan: async task => JSON.stringify(plan(task.request.includes("other") ? "b" : "a")),
    run: async () => "Completed fixture; no files changed.",
    safeError: error => error.message,
    ...overrides,
  });
  t.after(async () => { await engine.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, engine };
}

test("mode is off by default; burst intake is durable, independent and does not wait for planning", async t => {
  let calls = 0;
  const { engine, store, root, path } = fixture(t, { plan: async () => { calls++; return new Promise(() => {}); } });
  assert.equal(engine.enabled, false);
  assert.throws(() => engine.submit("task"), /off/);
  engine.on();
  const tasks = Array.from({ length: 10 }, (_, i) => engine.submit(`Task ${i}`));
  assert.equal(new Set(tasks.map(task => task.id)).size, 10);
  assert.equal(store.list("session").length, 10);
  await waitFor(() => calls === 1);
  const second = new TaskStore(path);
  try { assert.equal(second.list("session").length, 10); } finally { second.close(); }
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  await engine.off(); // Uncooperative planner cannot hang off/reload.
  assert.equal(store.list("session")[0].state, "paused");
  assert.equal(engine.enabled, false);
});

test("different workspaces run concurrently, but a shared workspace never has overlapping workers", async t => {
  const started = [];
  const { engine, store } = fixture(t, { run: async (task, signal) => { started.push(task); return finishable(signal); } });
  engine.on();
  engine.submit("first"); engine.submit("second"); engine.submit("other workspace");
  await waitFor(() => started.length === 2);
  assert.deepEqual(new Set(started.map(task => task.workspace)), new Set(["/project/a", "/project/b"]));
  assert.equal(store.list("session").filter(task => task.state === "ready").length, 1);
  await engine.off();
  assert.equal(engine.active.size, 0);
});

test("cross-instance claims and Git-common resource keys prevent simultaneous worktree writers", t => {
  const { store, path } = fixture(t);
  const first = store.add("one", "first");
  const p1 = store.claimPlan("one", "owner-a");
  store.planned(p1, "owner-a", plan(), "/repo/main", "same-git-root");
  const second = store.add("two", "second");
  const p2 = store.claimPlan("two", "owner-b");
  store.planned(p2, "owner-b", plan(), "/repo/worktree", "same-git-root");
  const other = new TaskStore(path);
  try {
    assert.ok(store.claimRun("one", first.id, "owner-a"));
    assert.equal(other.claimRun("two", second.id, "owner-b"), undefined);
    assert.throws(() => other.stopping("one", first.id, "owner-b"), /another live/);
  } finally { other.close(); }
  assert.throws(() => store.get("two", first.id), /does not belong/);
});

test("dependencies must be earlier known tasks; unknown projects/models and protocol injection are rejected", t => {
  const { store } = fixture(t);
  const first = store.add("session", "first");
  const task = store.add("session", `Use #${first.id} to do the second task`);
  assert.deepEqual(parsePlan(JSON.stringify(plan("a", [first.id])), task, { a: "/a" }, [first]).dependencies, [first.id]);
  for (const invalid of [plan("unknown"), { ...plan(), role: "admin" }, plan("a", [task.id]), plan("a", [999]), { ...plan(), title: null }]) {
    assert.throws(() => parsePlan(JSON.stringify(invalid), task, { a: "/a" }, [first]));
  }
  const p1 = store.claimPlan("session", "o"); store.planned(p1, "o", plan(), "/a", "/a");
  const p2 = store.claimPlan("session", "o"); store.planned(p2, "o", plan("b", [first.id]), "/b", "/b");
  assert.equal(store.claimRun("session", task.id, "o"), undefined);
  const run = store.claimRun("session", first.id, "o"); store.finish(run, "o", "done", "verified");
  assert.ok(store.claimRun("session", task.id, "o"));
});

test("cancellation keeps the resource locked until cleanup, then fences late completion", async t => {
  let release;
  const { engine, store } = fixture(t, { run: () => new Promise(resolve => { release = resolve; }) });
  engine.on(); const task = engine.submit("first"); engine.submit("second");
  await waitFor(() => release);
  const original = store.get("session", task.id);
  const stopping = engine.stopTask(task.id, true);
  assert.equal(store.get("session", task.id).state, "stopping");
  await delay(20);
  assert.equal(engine.active.size, 1);
  release("late success"); await stopping;
  assert.equal(store.get("session", task.id).state, "cancelled");
  assert.equal(store.finish(original, engine.owner, "done", "stale"), false);
  // Prevent the next queued fixture from starting an uncooperative fake worker.
  engine.enabled = false;
});

test("OFF waits for cleanup and cannot be overtaken by ON", async t => {
  let release;
  const { engine } = fixture(t, { run: () => new Promise(resolve => { release = resolve; }) });
  engine.on(); engine.submit("fixture");
  await waitFor(() => release);
  const off = engine.off();
  assert.ok(engine.offPromise);
  assert.throws(() => engine.on(), /still stopping/);
  release("late result"); await off;
  assert.equal(engine.offPromise, undefined);
  assert.equal(engine.active.size, 0);
});

test("task questions and replies are routed only to the identified worker", async t => {
  let answer;
  const { engine, store } = fixture(t, { run: (task, signal, question) => new Promise((resolve, reject) => {
    question("Which option?", value => { answer = value; resolve("Answered " + value); });
    signal.addEventListener("abort", () => reject(new Error("stop")), { once: true });
  }) });
  engine.on(); const task = engine.submit("question task");
  await waitFor(() => store.get("session", task.id).state === "waiting");
  await assert.rejects(engine.reply(task.id, ""), /blank/);
  await assert.rejects(engine.reply(999, "wrong task"), /does not belong/);
  await engine.reply(task.id, "option b");
  await waitFor(() => store.get("session", task.id).state === "done");
  assert.equal(answer, "option b");
  assert.match(store.get("session", task.id).request, /User reply to worker question.*option b/);
});

test("answering a waiting task never exceeds the active-worker cap", async t => {
  let answer, release;
  const { engine, store } = fixture(t, { maxWorkers: 1, run: (task, signal, question) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
    if (task.request === "ask") question("Which value?", text => { answer = text; resolve("answered"); });
    else release = () => resolve("other completed");
  }) });
  engine.on(); const first = engine.submit("ask"); engine.submit("other workspace");
  await waitFor(() => release);
  await engine.reply(first.id, "value");
  await delay(20);
  assert.equal(answer, undefined);
  assert.match(store.get("session", first.id).question, /Answer received/);
  release();
  await waitFor(() => store.get("session", first.id).state === "done");
  assert.equal(answer, "value");
});

test("scouts may overlap scouts but a writer cannot overlap either reader", t => {
  const { store } = fixture(t);
  const tasks = ["a", "b", "c"].map(text => store.add("session", text));
  for (const [index] of tasks.entries()) {
    const planned = store.claimPlan("session", "owner");
    store.planned(planned, "owner", { ...plan(), role: index < 2 ? "scout" : "worker" }, "/repo", "git");
  }
  assert.ok(store.claimRun("session", tasks[0].id, "owner"));
  assert.ok(store.claimRun("session", tasks[1].id, "owner"));
  assert.equal(store.claimRun("session", tasks[2].id, "owner"), undefined);
});

test("queued work respects limits, and expired dead-owner jobs require explicit resume", t => {
  const { store } = fixture(t);
  const task = store.add("session", "first", 1);
  assert.throws(() => store.add("session", "second", 1), /full/);
  store.claimPlan("session", "dead-owner");
  store.db.prepare("UPDATE tasks SET pid=999999999,lease=0 WHERE id=?").run(task.id);
  store.recover();
  assert.equal(store.get("session", task.id).state, "paused");
  store.resume("session", task.id, "Inspect partial state first.");
  assert.match(store.get("session", task.id).request, /partial state/);
});

test("RPC cancellation also kills an observed TERM-resistant detached descendant", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi rpc descendant "));
  const script = join(root, "worker.cjs"), pidFile = join(root, "child.pid");
  writeFileSync(script, `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);process.stdout.write(JSON.stringify({type:'response',id:c.id,success:true})+'\\n')});
    setInterval(()=>{},1000);
  `);
  const worker = new PiWorker(process.execPath, [script], root, () => {});
  let childPid;
  t.after(async () => { await worker.stop(); if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} } rmSync(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const running = worker.run("wait", 10000, controller.signal);
  const rejected = assert.rejects(running, /paused|stopped|cancelled/);
  await waitFor(() => existsSync(pidFile));
  childPid = Number(readFileSync(pidFile, "utf8"));
  await delay(50); controller.abort(); await rejected;
  await waitFor(() => { try { process.kill(childPid, 0); return false; } catch (error) { return error.code === "ESRCH"; } });
  childPid = undefined;
});

test("RPC uses settled completion, preserves Unicode JSONL, answers questions, and terminates owned processes", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi rpc fixture "));
  const script = join(root, "worker.cjs");
  writeFileSync(script, `
    let buffer=''; const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    process.stdin.on('data', chunk=>{ buffer+=chunk; let i; while((i=buffer.indexOf('\\n'))>=0){ const cmd=JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1);
      if(cmd.type==='prompt'){send({type:'response',id:cmd.id,success:true}); send({type:'message_end',message:{role:'assistant',stopReason:'error',content:[]}}); send({type:'agent_end'}); send({type:'extension_ui_request',id:'q',method:'input',title:'Question'});}
      else if(cmd.type==='extension_ui_response'){send({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'answer \\u2028 '+cmd.value}],usage:{input:3,output:4}}}); send({type:'agent_settled'});}
      else send({type:'response',id:cmd.id,success:true});
    }});
    setInterval(()=>{},1000);
  `);
  let worker;
  worker = new PiWorker(process.execPath, [script], root, request => worker.reply(request, "accepted"));
  t.after(async () => { await worker.stop(); rmSync(root, { recursive: true, force: true }); });
  const result = await worker.run("fixture", 5000, new AbortController().signal);
  assert.equal(result.text, "answer \u2028 accepted");
  assert.equal(result.usage.input, 3);
  assert.equal(worker.exited, true);
  assert.throws(() => process.kill(worker.child.pid, 0), { code: "ESRCH" });
});
