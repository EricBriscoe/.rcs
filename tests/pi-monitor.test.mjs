import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { MonitorDispatcher, MonitorManager, OutputBuffer, monitorMessage } from "../pi/extensions/monitor/monitor.mjs";

function quote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function nodeCommand(script) {
  return `${quote(process.execPath)} -e ${quote(script)}`;
}

async function waitFor(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for local monitor fixture.");
    await delay(10);
  }
}

async function fixture(t, options) {
  const cwd = await mkdtemp(join(tmpdir(), "pi monitor test "));
  const manager = new MonitorManager(options);
  t.after(async () => {
    try { await manager.close(); }
    finally { await rm(cwd, { recursive: true, force: true }); }
  });
  return { cwd, manager };
}

function finished(manager, id) {
  return manager.get(id).closed;
}

function outputText(update) {
  return update.chunks.map((chunk) => chunk.text).join("");
}

test("output buffer retains the bounded tail with stream labels and explicit loss", () => {
  const buffer = new OutputBuffer(8);
  buffer.append("stdout", "abcdef");
  buffer.append("stderr", "123456");
  assert.equal(buffer.length, 8);
  assert.deepEqual(buffer.take(5), {
    chunks: [{ stream: "stdout", text: "ef" }, { stream: "stderr", text: "123" }],
    droppedCharacters: 4,
  });
  assert.deepEqual(buffer.take(5), { chunks: [{ stream: "stderr", text: "456" }], droppedCharacters: 0 });
  assert.deepEqual(buffer.take(5), { chunks: [], droppedCharacters: 0 });
});

test("monitor messages drain only new stdout/stderr and include the exit status", async (t) => {
  const { manager, cwd } = await fixture(t);
  const gate = join(cwd, "continue");
  const started = await manager.start(nodeCommand(`
    const fs = require('node:fs');
    process.stdout.write('first batch\\n');
    const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(gate)})) {
        process.stderr.write('second batch\\n');
        clearInterval(timer);
        process.exitCode = 9;
      }
    }, 10);
  `), cwd);
  await waitFor(() => manager.get(started.id).output.length > 0);
  const first = monitorMessage(manager);
  assert.equal(first.customType, "monitor-output");
  assert.equal(first.display, true);
  assert.deepEqual(first.details.monitors[0].chunks, [{ stream: "stdout", text: "first batch\n" }]);
  assert.equal(first.details.monitors[0].status, "running");
  assert.equal(monitorMessage(manager), undefined);

  await writeFile(gate, "continue");
  await waitFor(() => finished(manager, started.id));
  const second = monitorMessage(manager);
  assert.deepEqual(second.details.monitors[0].chunks, [{ stream: "stderr", text: "second batch\n" }]);
  assert.equal(second.details.monitors[0].exitCode, 9);
  assert.equal(second.details.monitors[0].status, "exited");
  assert.doesNotMatch(JSON.stringify(second.details.monitors[0].chunks), /first batch/);
  assert.equal(monitorMessage(manager), undefined);
});

test("real process output is bounded and list does not consume pending output", async (t) => {
  const { manager, cwd } = await fixture(t, { outputLimit: 32, drainLimit: 10 });
  const started = await manager.start(nodeCommand("process.stdout.write('0123456789'.repeat(10))"), cwd);
  await waitFor(() => finished(manager, started.id));
  const listed = manager.list()[0];
  assert.equal(listed.bufferedCharacters, 32);
  assert.equal(listed.droppedCharacters, 68);
  let text = "";
  let dropped = 0;
  while (true) {
    const updates = manager.drain(started.id);
    if (!updates.length) break;
    assert.ok(outputText(updates[0]).length <= 10);
    text += outputText(updates[0]);
    dropped += updates[0].droppedCharacters;
  }
  assert.equal(text, "0123456789".repeat(10).slice(-32));
  assert.equal(dropped, 68);
  assert.equal(manager.list()[0].bufferedCharacters, 0);
});

test("silent completion is delivered once and consumed records make room for new monitors", async (t) => {
  const { manager, cwd } = await fixture(t, { maxMonitors: 1 });
  const first = await manager.start("exit 7", cwd);
  await waitFor(() => finished(manager, first.id));
  await assert.rejects(manager.start("exit 0", cwd), /At most 1 monitors/);
  const update = manager.drain()[0];
  assert.equal(update.exitCode, 7);
  assert.deepEqual(update.chunks, []);
  assert.deepEqual(manager.drain(), []);
  const second = await manager.start("exit 0", cwd);
  assert.notEqual(first.id, second.id);
  assert.equal(manager.list().length, 1);
});

test("invalid starts do not leave a retained monitor", async (t) => {
  const { manager, cwd } = await fixture(t);
  await assert.rejects(manager.start(" ", cwd), /command is required/);
  await assert.rejects(manager.start("printf fixture", join(cwd, "missing")), /Could not start monitor/);
  assert.deepEqual(manager.list(), []);
  assert.throws(() => manager.drain("missing"), /Unknown monitor/);
  await assert.rejects(manager.stop("missing"), /Unknown monitor/);
});

test("stop terminates an owned process group including a TERM-resistant child", async (t) => {
  const { manager, cwd } = await fixture(t, { stopGraceMs: 100 });
  const started = await manager.start(nodeCommand(`
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {});
    spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('child-ready:' + process.pid); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
    setInterval(() => {}, 1000);
  `), cwd);
  await waitFor(() => manager.get(started.id).output.chunks.some((chunk) => /child-ready:\d+/.test(chunk.text)));
  const before = manager.drain(started.id)[0];
  const childPid = Number(outputText(before).match(/child-ready:(\d+)/)[1]);
  const stopStarted = Date.now();
  const stopped = await manager.stop(started.id);
  assert.ok(Date.now() - stopStarted < 2500);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.signal, "SIGKILL");
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(-started.pid, 0), { code: "ESRCH" });
  const originalKill = process.kill;
  t.mock.method(process, "kill", (pid, signal) => {
    assert.notEqual(pid, -started.pid, "A retired process group must not be probed or signalled again.");
    return originalKill.call(process, pid, signal);
  });
  assert.equal((await manager.stop(started.id)).status, "stopped");
  await manager.close();
});

test("continuously noisy monitors each receive a share of every output batch", async (t) => {
  const { manager, cwd } = await fixture(t, { outputLimit: 16, drainLimit: 12 });
  const monitors = [];
  for (const text of ["A", "B", "C"]) {
    monitors.push(await manager.start(nodeCommand(`setInterval(() => process.stdout.write('${text}'.repeat(32)), 5)`), cwd));
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitFor(() => monitors.every(({ id }) => manager.get(id).output.length === 16));
    const updates = manager.drain();
    assert.deepEqual(updates.map(({ id }) => id), monitors.map(({ id }) => id));
    assert.deepEqual(updates.map((update) => outputText(update).length), [4, 4, 4]);
  }
});

function dispatcherFixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let pending = [];
  let idle = true;
  const sent = [];
  const manager = {
    hasPending: () => pending.length > 0,
    drain: () => { const drained = pending; pending = []; return drained; },
  };
  const dispatcher = new MonitorDispatcher({ manager, send: (message) => sent.push(message), isIdle: () => idle });
  t.after(() => dispatcher.dispose());
  return {
    dispatcher, sent,
    output: (text) => { pending.push({ chunks: [{ stream: "stdout", text }] }); dispatcher.notify(); },
    idle: (value) => { idle = value; },
  };
}

test("output wakes an idle agent after one fixed batch window without waiting for a user", (t) => {
  const { output, sent } = dispatcherFixture(t);
  output("first");
  t.mock.timers.tick(400);
  output("second");
  assert.equal(sent.length, 0);
  t.mock.timers.tick(100);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].details.monitors.length, 2);
  t.mock.timers.tick(5000);
  assert.equal(sent.length, 1);
});

test("busy output stays buffered until the run settles and only one wake is outstanding", (t) => {
  const { output, sent, idle, dispatcher } = dispatcherFixture(t);
  idle(false);
  dispatcher.started();
  output("during the current run");
  t.mock.timers.tick(500);
  assert.equal(sent.length, 0);
  idle(true);
  dispatcher.settled();
  t.mock.timers.tick(500);
  assert.equal(sent.length, 1);
  output("after the wake was queued");
  t.mock.timers.tick(5000);
  assert.equal(sent.length, 1);
  dispatcher.started();
  dispatcher.settled();
  t.mock.timers.tick(500);
  assert.equal(sent.length, 2);
  assert.match(sent[1].content, /after the wake was queued/);
  assert.doesNotMatch(sent[1].content, /during the current run/);
});

test("session disposal cancels pending wakeups and fences late output callbacks", (t) => {
  const { output, sent, dispatcher } = dispatcherFixture(t);
  output("before shutdown");
  dispatcher.dispose();
  output("late callback");
  dispatcher.settled();
  t.mock.timers.tick(5000);
  assert.equal(sent.length, 0);
});

test("output during manual compaction wakes Pi once it becomes idle without an agent event", (t) => {
  const { output, sent, idle } = dispatcherFixture(t);
  idle(false);
  output("completed while compacting");
  t.mock.timers.tick(500);
  assert.equal(sent.length, 0);
  idle(true);
  t.mock.timers.tick(500);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /completed while compacting/);
});

test("session cleanup stops every owned monitor and prevents later starts", async (t) => {
  const { manager, cwd } = await fixture(t);
  const first = await manager.start(nodeCommand("setInterval(() => {}, 1000)"), cwd);
  const second = await manager.start(nodeCommand("setInterval(() => {}, 1000)"), cwd);
  await manager.close();
  assert.deepEqual(manager.list(), []);
  for (const pid of [first.pid, second.pid]) {
    assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" });
  }
  await assert.rejects(manager.start("exit 0", cwd), /shutting down/);
  await manager.close();
});
