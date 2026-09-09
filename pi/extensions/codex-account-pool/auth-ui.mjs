export const LOGIN_CANCELLED = 'Login cancelled';

/** Match known failure categories; never echo OAuth responses, URLs, or tokens. */
export function loginFailure(error) {
  const message = error instanceof Error ? error.message : '';
  if (error?.name === 'AbortError' || message === LOGIN_CANCELLED) return { cancelled: true };
  if (/same ChatGPT account/.test(message)) return { message: 'You signed into a different ChatGPT account. Sign into the account originally saved under this name, or add the other account separately.' };
  if (/already in the pool|already uses that name/.test(message)) return { message: 'That account or name is already saved. Choose the existing account in settings and select Sign in again.' };
  if (/State mismatch/.test(message)) return { message: 'This callback belongs to a different login attempt. Retry and use only the newest browser tab or redirect URL.' };
  if (/Missing authorization code/.test(message)) return { message: 'The browser did not return a login code. Retry, paste the complete redirect URL into Pi, or use a device code.' };
  if (/device code login is not enabled/.test(message)) return { message: 'Device-code login is unavailable for this account or server. Try browser login.' };
  if (/expired|timed? out|timeout/i.test(message)) return { message: 'The login attempt expired. Start a new attempt and complete it before it expires.' };
  if (/fetch failed|network|ENOTFOUND|ECONN|EAI_AGAIN/i.test(message) || /ENOTFOUND|ECONN|EAI_AGAIN/.test(error?.cause?.code ?? '')) return { message: 'Pi could not reach OpenAI. Check your connection, then retry browser or device-code login.' };
  if (/EACCES|EPERM|ENOSPC|EROFS|pool state is invalid|lock/.test(message) || ['EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes(error?.code)) return { message: 'Pi could not save the login. Check local storage permissions and free space. Resolve the storage problem before retrying.' };
  const status = /(?:failed \(|status )(\d{3})/.exec(message)?.[1];
  if (status) return { message: `OpenAI rejected the login request (HTTP ${status}). Retry with a new browser or device-code login.` };
  if (/missing fields|incomplete credentials|accountId|account identity/.test(message)) return { message: 'OpenAI returned an incomplete login. Try a new sign-in; the saved account has not been replaced.' };
  return { message: 'Login did not finish. The provider returned an unrecognized error; private response details were withheld. Retry in the browser or use a device code.' };
}

export async function chooseLoginMethod(ctx) {
  const choices = ['Open browser on this Mac', 'Use a device code'];
  const selected = await ctx.ui.select('How would you like to sign in?', choices, { signal: ctx.signal });
  return selected === choices[0] ? 'browser' : selected === choices[1] ? 'device' : undefined;
}

export async function loginWithRecovery(ctx, { label, method, attempt }) {
  if (!ctx.hasUI) throw new Error('Open /codex-pool in interactive Pi to sign in.');
  if (ctx.signal?.aborted) return false;
  let chosen = ['browser', 'device'].includes(method) ? method : await chooseLoginMethod(ctx);
  while (chosen && !ctx.signal?.aborted) {
    try {
      await attempt(chosen);
      return true;
    } catch (error) {
      const failure = loginFailure(error);
      if (failure.cancelled || ctx.signal?.aborted) break;
      ctx.ui.notify(`Could not sign in to ${label}. ${failure.message}`, 'warning');
      const retry = await ctx.ui.select('Sign-in recovery', ['Retry in browser', 'Try device code', 'Back to settings'], { signal: ctx.signal });
      chosen = retry === 'Retry in browser' ? 'browser' : retry === 'Try device code' ? 'device' : undefined;
    }
  }
  if (!ctx.signal?.aborted) ctx.ui.notify('Sign-in closed. You can retry from account settings.', 'info');
  return false;
}

/** Complete partial slash commands with the same dialogs used by settings. */
export async function completePoolArguments(action, args, ctx, readState) {
  const result = [...args];
  const named = ['add', 'login', 'relogin', 'remove', 'priority'].includes(action);
  if (!named) return result;
  const state = await readState();
  if (!result[0]) {
    if (!ctx.hasUI) throw new Error('This command needs an account name. Open /codex-pool in interactive Pi to choose one.');
    if (action === 'add' || action === 'login') {
      result[0] = (await ctx.ui.input('Name this account', 'For example: personal or work', { signal: ctx.signal }))?.trim();
    } else {
      if (!state.accounts.length) { ctx.ui.notify('No accounts saved. Open /codex-pool and choose Add account.', 'info'); return undefined; }
      result[0] = await ctx.ui.select('Choose a Codex account', state.accounts.map(account => account.label), { signal: ctx.signal });
    }
    if (!result[0]) return undefined;
  }
  if (!['add', 'login'].includes(action) && !state.accounts.some(account => account.label === result[0])) {
    throw new Error('No saved account has that name. Open /codex-pool to choose an existing account.');
  }
  if (['add', 'login'].includes(action) && state.accounts.some(account => account.label === result[0])) {
    throw new Error('That account name is already saved. Open /codex-pool, choose it, and select Sign in again.');
  }
  if (action === 'priority' && (!Number.isInteger(Number(result[1])) || Number(result[1]) < 1)) {
    if (!ctx.hasUI) throw new Error('Choose a priority in /codex-pool, or supply a positive position number.');
    const positions = state.accounts.map((_, index) => `${index + 1}${index === 0 ? ' — primary' : ' — backup'}`);
    const choice = await ctx.ui.select('Choose account priority', positions, { signal: ctx.signal });
    if (!choice) return undefined;
    result[1] = String(positions.indexOf(choice) + 1);
  }
  ctx.signal?.throwIfAborted();
  return result;
}
