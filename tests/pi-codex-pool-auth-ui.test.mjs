import assert from 'node:assert/strict';
import test from 'node:test';
import { completePoolArguments, loginFailure, loginWithRecovery } from '../pi/extensions/codex-account-pool/auth-ui.mjs';

function context(answers = []) {
  const notices = [], dialogs = [];
  return { hasUI: true, notices, dialogs, ui: {
    notify: (message, level) => notices.push({ message, level }),
    select: async (title, choices) => { dialogs.push({ title, choices }); return answers.shift(); },
    input: async () => answers.shift(),
  } };
}

test('login errors identify recovery steps without copying provider responses or credentials', () => {
  const cases = [
    ['Re-login must authenticate the same ChatGPT account; remove and add it explicitly to change account identity.', /different ChatGPT account/],
    ['This ChatGPT account is already in the pool.', /already saved/],
    ['State mismatch', /newest browser tab/],
    ['Missing authorization code', /redirect URL/],
    ['OpenAI Codex device code login is not enabled for this server.', /Try browser login/],
    ['Login timed out', /expired/],
    ['fetch failed', /could not reach OpenAI/],
    ['EACCES permission denied', /storage permissions/],
    ['OpenAI Codex token exchange failed (401): secret-access-token', /HTTP 401/],
    ['OpenAI Codex token exchange response missing fields: secret-refresh-token', /incomplete login/],
    ['secret-unrecognized-provider-response', /unrecognized error/],
  ];
  for (const [message, expected] of cases) {
    const result = loginFailure(new Error(message));
    assert.match(result.message, expected);
    assert.doesNotMatch(result.message, /secret-/);
  }
  assert.deepEqual(loginFailure(new Error('Login cancelled')), { cancelled: true });
});

test('failed browser login offers a device retry and reports success only after it completes', async () => {
  const ctx = context(['Try device code']);
  const methods = [];
  const result = await loginWithRecovery(ctx, { label: 'personal', method: 'browser', attempt: async method => {
    methods.push(method);
    if (method === 'browser') throw new Error('State mismatch');
  } });
  assert.equal(result, true);
  assert.deepEqual(methods, ['browser', 'device']);
  assert.match(ctx.notices[0].message, /different login attempt/);
});

test('cancellation never triggers another login or reports success', async () => {
  const cancelled = context();
  assert.equal(await loginWithRecovery(cancelled, { label: 'personal', method: 'browser', attempt: async () => { throw new Error('Login cancelled'); } }), false);
  assert.equal(cancelled.dialogs.length, 0);
  const back = context(['Back to settings']);
  let attempts = 0;
  assert.equal(await loginWithRecovery(back, { label: 'personal', method: 'browser', attempt: async () => { attempts++; throw new Error('fetch failed'); } }), false);
  assert.equal(attempts, 1);
  const noMethod = context([undefined]);
  assert.equal(await loginWithRecovery(noMethod, { label: 'personal', attempt: () => assert.fail('Cancelled method must not start OAuth') }), false);
});

test('partial re-login and priority commands ask for missing arguments', async () => {
  const readState = async () => ({ accounts: [{ label: 'personal' }, { label: 'work account' }] });
  const ctx = context(['work account', '2 — backup']);
  assert.deepEqual(await completePoolArguments('priority', [], ctx, readState), ['work account', '2']);
  const login = context(['personal']);
  assert.deepEqual(await completePoolArguments('relogin', [], login, readState), ['personal']);
  const add = context([' new account ']);
  assert.deepEqual(await completePoolArguments('add', [], add, readState), ['new account']);
});

test('empty pools, unknown accounts, and cancelled argument dialogs never start login', async () => {
  const empty = context();
  assert.equal(await completePoolArguments('relogin', [], empty, async () => ({ accounts: [] })), undefined);
  assert.match(empty.notices[0].message, /Add account/);
  const readState = async () => ({ accounts: [{ label: 'personal' }] });
  await assert.rejects(completePoolArguments('relogin', ['missing'], context(), readState), /No saved account/);
  await assert.rejects(completePoolArguments('add', ['personal'], context(), readState), /already saved/);
  assert.equal(await completePoolArguments('relogin', [], context([undefined]), readState), undefined);
  assert.deepEqual(await completePoolArguments('disable', [], context(), readState), [], 'no name intentionally means the whole pool');
  await assert.rejects(completePoolArguments('relogin', [], { hasUI: false }, readState), /interactive Pi/);
});
