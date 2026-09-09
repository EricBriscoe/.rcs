import { compactQuota } from './quota.mjs';

export const POOL_HELP = 'Pool accounts use your ChatGPT subscription. Add an account, sign in, then enable the pool. Accounts are tried in priority order; backups are used only when subscription quota is exhausted before a response starts. Re-login refreshes the same account. Remove deletes its saved pool login. Pi /login and /logout use a separate store; disable the pool to use those instead.';

async function pick(ctx, title, choices) {
  const selected = await ctx.ui.select(title, choices.map(choice => choice.label), { signal: ctx.signal });
  return choices.find(choice => choice.label === selected)?.value;
}

async function loginMethod(ctx) {
  return pick(ctx, 'How would you like to sign in?', [
    { label: 'Open browser on this Mac', value: 'browser' },
    { label: 'Use a device code in another browser', value: 'device' },
  ]);
}

/** Native dialogs only; account mutations and confirmations stay in the command handler. */
export async function openPoolMenu(ctx, { readState, execute: perform }) {
  const execute = async (action, args) => {
    ctx.signal?.throwIfAborted();
    if (!['status', 'quota'].includes(action) && !ctx.isIdle()) throw new Error('Wait for the current response to finish before changing accounts.');
    return perform(action, args);
  };
  if (!ctx.hasUI) { await execute('status', []); return; }
  while (!ctx.signal?.aborted) {
    const state = await readState();
    const choices = [
      { label: 'Add account — sign in with ChatGPT', value: 'add' },
      ...state.accounts.map((account, index) => ({
        label: `${index + 1}. ${account.label} — ${account.enabled ? 'on' : 'off'} · ${account.exhausted ? 'quota cooldown · ' : ''}${compactQuota(account.quota)}`,
        value: account,
      })),
      ...(state.accounts.length ? [{ label: 'Refresh quota for all accounts', value: 'quota' }] : []),
      ...(state.enabled || state.accounts.some(account => account.enabled) ? [{
        label: state.enabled ? 'Disable pool — use ordinary Pi login' : 'Enable pool — use these accounts',
        value: state.enabled ? 'disable' : 'enable',
      }] : []),
      { label: 'How login, logout, and failover work', value: 'help' },
      { label: 'Done', value: 'done' },
    ];
    const choice = await pick(ctx, `Codex accounts · pool ${state.enabled ? 'enabled' : 'disabled'}\n${state.accounts.length ? 'Choose an account to manage it. Priority 1 goes first.' : 'No accounts yet. Add one to get started.'}`, choices);
    if (choice === undefined || choice === 'done' || ctx.signal?.aborted) return;
    try {
      if (choice === 'help') { ctx.ui.notify(POOL_HELP, 'info'); continue; }
      if (choice === 'quota') { await execute('quota', []); continue; }
      if (!ctx.isIdle()) { ctx.ui.notify('Wait for the current response to finish before changing accounts.', 'warning'); continue; }
      if (choice === 'add') {
        const label = (await ctx.ui.input('Name this account', 'For example: personal or work', { signal: ctx.signal }))?.trim();
        if (!label) continue;
        if (state.accounts.some(account => account.label === label)) {
          ctx.ui.notify('That name is already in use. Choose the existing account to sign in again.', 'warning');
          continue;
        }
        const method = await loginMethod(ctx);
        if (!method) continue;
        if (await execute('add', [label, method]) === false) continue;
        if (!(await readState()).enabled) {
          const enable = await pick(ctx, 'Account added. Use the pool now?', [
            { label: 'Enable pool', value: true },
            { label: 'Keep it disabled for now', value: false },
          ]);
          if (enable === true) await execute('enable', []);
        }
      } else if (typeof choice === 'string') {
        await execute(choice, []);
      } else {
        const account = choice;
        const action = await pick(ctx, `Manage ${account.label}`, [
          { label: 'Sign in again — same ChatGPT account', value: 'relogin' },
          { label: 'Refresh quota', value: 'quota' },
          { label: 'Change priority', value: 'priority' },
          { label: account.enabled ? 'Disable this account' : 'Enable this account', value: account.enabled ? 'disable' : 'enable' },
          { label: 'Remove saved login from pool…', value: 'remove' },
          { label: 'Back', value: 'back' },
        ]);
        if (!action || action === 'back') continue;
        if (action === 'relogin') {
          const method = await loginMethod(ctx);
          if (method) await execute(action, [account.label, method]);
        } else if (action === 'priority') {
          const position = await pick(ctx, `Priority for ${account.label}`, state.accounts.map((_, index) => ({
            label: index === 0 ? '1 — primary account' : `${index + 1} — backup account`, value: String(index + 1),
          })));
          if (position) await execute(action, [account.label, position]);
        } else await execute(action, [account.label]);
      }
    } catch (error) {
      if (ctx.signal?.aborted) return;
      ctx.ui.notify(error instanceof Error ? error.message : 'Could not update the Codex pool.', 'error');
    }
  }
}
