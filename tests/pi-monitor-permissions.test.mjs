import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { MonitorManager, monitorMessage } from '../pi/extensions/monitor/monitor.ts';

const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const nodeCommand = script => `${quote(process.execPath)} -e ${quote(script)}`;
const denied = code => Object.assign(new Error(`kill ${code}`), { code, syscall: 'kill' });
async function waitFor(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Permission fixture timed out');
    await delay(10);
  }
}

function fixture(t, options) {
  const originalKill = process.kill;
  const manager = new MonitorManager(options);
  t.after(async () => {
    // Test-only cleanup of our still-running fixture leaders using the unmocked
    // syscall. Never signal a closed/reaped PID, even when the mock denied probing.
    for (const record of manager.monitors.values()) {
      if (!record.exited) {
        try { originalKill.call(process, -record.child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    await waitFor(() => [...manager.monitors.values()].every(record => record.closed));
    if (manager.list().some(record => record.cleanupError)) {
      await assert.rejects(manager.close(), /Could not verify cleanup/);
    } else await manager.close();
  });
  return { manager, inject(pid, fail) {
    const calls = [];
    t.mock.method(process, 'kill', (target, signal) => {
      if (target === -pid) {
        calls.push(signal);
        const code = fail(signal);
        if (code) throw denied(code);
      }
      return originalKill.call(process, target, signal);
    });
    return calls;
  } };
}

for (const code of ['EPERM', 'EINVAL']) {
  for (const notifyOn of ['completion', 'output']) {
    test(`${code} in a real child close callback is non-fatal and preserves ${notifyOn} delivery`, async t => {
      const { manager, inject } = fixture(t, { maxMonitors: 1 });
      const job = await manager.start('printf finished; sleep 0.1', '/tmp', notifyOn);
      const calls = inject(job.pid, signal => signal === 0 ? code : undefined);
      if (notifyOn === 'output') manager.get(job.id).child.once('exit', () => manager.drain(job.id));
      await waitFor(() => manager.get(job.id).closed);
      const record = manager.get(job.id);
      assert.equal(record.groupGone, false, 'permission errors are never absence');
      const update = monitorMessage(manager).details.monitors[0];
      assert.equal(update.status, 'exited');
      assert.equal(update.exitCode, 0);
      assert.match(update.cleanupError, new RegExp(`probe failed \\(${code}\\).*cleanup unverified`));
      if (notifyOn === 'completion') assert.equal(update.chunks.map(chunk => chunk.text).join(''), 'finished');
      assert.equal(monitorMessage(manager), undefined, 'warning is consumed once');
      await assert.rejects(manager.stop(job.id), /cleanup unverified/);
      manager.drain(job.id);
      await assert.rejects(manager.start('exit 0', '/tmp'), /At most 1 monitors/);
      assert.equal(manager.list().length, 1, 'unresolved record is not pruned');
      assert.deepEqual(calls, [0], 'an uncertain PGID is never probed or signalled again');
    });
  }
}

test('permission-denied probe during stop sends no termination signals and remains visible', async t => {
  const { manager, inject } = fixture(t);
  const job = await manager.start(nodeCommand("console.log('ready'); setInterval(() => {}, 1000)"), '/tmp');
  await waitFor(() => manager.get(job.id).output.length > 0);
  const calls = inject(job.pid, signal => signal === 0 ? 'EPERM' : undefined);
  await assert.rejects(manager.stop(job.id), /probe failed \(EPERM\)/);
  assert.equal(manager.get(job.id).stopRequested, false);
  assert.equal(manager.list()[0].status, 'running');
  assert.match(manager.drain(job.id)[0].cleanupError, /No further group signals/);
  await assert.rejects(manager.stop(job.id), /cleanup unverified/);
  assert.deepEqual(calls, [0]);
});

for (const failedSignal of ['SIGTERM', 'SIGKILL']) {
  test(`${failedSignal} EPERM reports failed cleanup without unsafe retries or escalation`, async t => {
    const { manager, inject } = fixture(t, { stopGraceMs: 10 });
    const job = await manager.start(nodeCommand("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"), '/tmp');
    await waitFor(() => manager.get(job.id).output.length > 0);
    const calls = inject(job.pid, signal => signal === failedSignal ? 'EPERM' : undefined);
    await assert.rejects(manager.stop(job.id), new RegExp(`${failedSignal} failed \\(EPERM\\)`));
    assert.equal(manager.list()[0].status, 'running');
    assert.equal(manager.get(job.id).groupGone, false);
    assert.equal(manager.get(job.id).stopRequested, failedSignal === 'SIGKILL', 'a rejected TERM is not a successful stop request');
    const attempted = calls.filter(signal => signal !== 0);
    assert.deepEqual(attempted, failedSignal === 'SIGTERM' ? ['SIGTERM'] : ['SIGTERM', 'SIGKILL']);
    const count = calls.length;
    await assert.rejects(manager.stop(job.id), /cleanup unverified/);
    assert.equal(calls.length, count, 'no later PGID reuse can cause a retry');
    assert.match(manager.drain(job.id)[0].cleanupError, /EPERM/);
  });
}

test('ESRCH between a successful probe and TERM retires the group without claiming a sent signal', async t => {
  const { manager, inject } = fixture(t);
  const job = await manager.start('sleep 0.2', '/tmp');
  const calls = inject(job.pid, signal => signal === 'SIGTERM' ? 'ESRCH' : undefined);
  const result = await manager.stop(job.id);
  assert.equal(manager.get(job.id).groupGone, true);
  assert.equal(manager.get(job.id).stopRequested, false);
  assert.equal(result.status, 'exited');
  assert.equal(result.cleanupError, undefined);
  assert.deepEqual(calls, [0, 'SIGTERM']);
});

test('shutdown attempts other groups but reports and retains unresolved cleanup', async t => {
  const { manager, inject } = fixture(t);
  const first = await manager.start('printf ready; sleep 10', '/tmp');
  const second = await manager.start('printf ready; sleep 10', '/tmp');
  await waitFor(() => [first, second].every(job => manager.get(job.id).output.length > 0));
  inject(first.pid, signal => signal === 0 ? 'EPERM' : undefined);
  await assert.rejects(manager.close(), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /EPERM.*cleanup unverified/);
    assert.ok(error.message.includes(first.id));
    return true;
  });
  assert.equal(manager.get(first.id).exited, false);
  await waitFor(() => manager.get(second.id).closed);
  assert.equal(manager.get(second.id).signal, 'SIGTERM', 'other groups still receive cleanup');
  // macOS may itself return EPERM immediately after TERM, before reaping. That
  // must remain unverified rather than turning this test into a false success.
  assert.ok(manager.get(second.id).groupGone || manager.get(second.id).cleanupError);
  assert.equal(manager.list().length, 2, 'cleanup failure is not discarded');
});
