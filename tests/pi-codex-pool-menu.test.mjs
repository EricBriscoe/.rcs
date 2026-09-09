import assert from 'node:assert/strict';
import test from 'node:test';
import { openPoolMenu } from '../pi/extensions/codex-account-pool/menu.mjs';
import { createFooterController } from '../pi/extensions/codex-account-pool/footer.mjs';

function fixture(steps, accounts = [], enabled = false) {
  const state = { enabled, accounts };
  const calls = [], notices = [];
  const controller = new AbortController();
  const ctx = {
    hasUI: true, signal: controller.signal, isIdle: () => true,
    ui: {
      select: async (title, choices) => {
        assert.ok(steps.length, `Unexpected dialog: ${title}`);
        const step = steps.shift();
        if (typeof step === 'function') return step(title, choices);
        if (step === undefined) return undefined;
        const match = choices.find(choice => choice.startsWith(step));
        assert.ok(match, `Missing choice ${step} in ${choices}`);
        return match;
      },
      input: async () => steps.shift(),
      notify: (message, level) => notices.push({ message, level }),
    },
  };
  const service = {
    readState: async () => state,
    execute: async (action, args) => {
      calls.push([action, args]);
      if (action === 'add') state.accounts.push({ label: args[0], enabled: true });
      if (action === 'enable' && args.length === 0) state.enabled = true;
    },
  };
  return { state, calls, notices, ctx, service, controller, run: () => openPoolMenu(ctx, service) };
}

test('first account setup guides naming, browser login, and explicit enablement', async () => {
  const f = fixture(['Add account', ' Personal account ', 'Open browser', 'Enable pool', 'Done']);
  await f.run();
  assert.deepEqual(f.calls, [['add', ['Personal account', 'browser']], ['enable', []]]);
});

test('cancelling setup at each step never logs in or enables by default', async () => {
  for (const steps of [[undefined], ['Add account', undefined, 'Done'], ['Add account', '  ', 'Done'], ['Add account', 'personal', undefined, 'Done']]) {
    const f = fixture(steps);
    await f.run();
    assert.deepEqual(f.calls, []);
  }
  const f = fixture(['Add account', 'personal', 'Use a device', undefined, 'Done']);
  await f.run();
  assert.deepEqual(f.calls, [['add', ['personal', 'device']]]);
  assert.equal(f.state.enabled, false);
});

test('duplicate names are rejected before starting OAuth', async () => {
  const f = fixture(['Add account', 'personal', 'Done'], [{ label: 'personal', enabled: true }]);
  await f.run();
  assert.deepEqual(f.calls, []);
  assert.match(f.notices[0].message, /already in use/);
});

test('account menus preserve labels and delegate removal to the confirming handler', async () => {
  const f = fixture([
    '1. Personal account', 'Sign in again', 'Use a device',
    '1. Personal account', 'Change priority', '2 —',
    '1. Personal account', 'Disable this account',
    '1. Personal account', 'Refresh quota',
    '1. Personal account', 'Remove saved login', 'Done',
  ], [{ label: 'Personal account', enabled: true }, { label: 'work', enabled: false }], true);
  await f.run();
  assert.deepEqual(f.calls, [
    ['relogin', ['Personal account', 'device']], ['priority', ['Personal account', '2']],
    ['disable', ['Personal account']], ['quota', ['Personal account']], ['remove', ['Personal account']],
  ]);
});

test('back and cancelled account actions do not mutate accounts', async () => {
  const f = fixture(['1.', 'Back', '1.', 'Change priority', undefined, '1.', 'Sign in again', undefined, 'Done'], [{ label: 'personal', enabled: true }]);
  await f.run();
  assert.deepEqual(f.calls, []);
});

test('failed login stays in settings and never offers to enable the pool', async () => {
  const f = fixture(['Add account', 'personal', 'Open browser', 'Done']);
  f.service.execute = async () => { throw new Error('Login cancelled'); };
  await f.run();
  assert.equal(f.state.enabled, false);
  assert.equal(f.notices[0].message, 'Login cancelled');
});

test('busy and aborted sessions cannot submit settings changes', async () => {
  const busy = fixture(['Add account', 'Done']);
  busy.ctx.isIdle = () => false;
  await busy.run();
  assert.deepEqual(busy.calls, []);
  const aborted = fixture(['Add account', 'personal', (_title, options) => { aborted.controller.abort(); return options[0]; }]);
  await aborted.run();
  assert.deepEqual(aborted.calls, []);
});

test('headless usage remains read-only status output', async () => {
  const f = fixture([]);
  f.ctx.hasUI = false;
  await f.run();
  assert.deepEqual(f.calls, [['status', []]]);
});

test('disabled pools keep settings discoverable and shutdown clears the hint', async () => {
  const rendered = [];
  const footer = createFooterController({
    readState: async () => ({ enabled: false, accounts: [] }),
    disabledStatus: 'Codex pool disabled',
    renderStatus: (_ctx, value) => rendered.push(value),
    setTimer: () => assert.fail('Disabled pools do not poll'),
  });
  await footer.update({});
  footer.shutdown({});
  assert.deepEqual(rendered, ['Codex pool disabled', undefined]);
});
