import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const host = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const { clearExtensionCache, loadExtensionsCached } = await import(pathToFileURL(join(host, 'dist/core/extensions/loader.js')));
const webPath = join(root, 'pi/extensions/web/index.ts');
const chromeRoot = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'npm/node_modules/pi-chrome');
const chromePath = join(chromeRoot, 'extensions/chrome-profile-bridge/index.ts');

test('fallback tools carry Chrome preference without disabling isolated browsing', async t => {
  clearExtensionCache();
  const loaded = await loadExtensionsCached([webPath], root);
  t.after(() => { loaded.runtime.invalidate(); clearExtensionCache(); });
  assert.deepEqual(loaded.errors, []);
  const tools = loaded.extensions[0].tools;
  assert.deepEqual([...tools.keys()], ['web_search', 'web_browse']);
  const browse = tools.get('web_browse').definition;
  assert.match(browse.description, /Fallback isolated Playwright browser/);
  const policy = browse.promptGuidelines.join('\n');
  assert.match(policy, /Prefer pi-chrome.*authorized and connected/);
  assert.match(policy, /presence alone does not prove connectivity/);
  assert.match(policy, /absent, locked, disconnected, or unsuitable/);
  assert.match(policy, /does not require the Chrome session/);
  assert.match(policy, /Never auto-authorize Chrome/);
  assert.match(policy, /Do not blindly replay uncertain mutations/);
  assert.match(policy, /stale element refs/);
  assert.match(policy, /Do not copy cookies or credentials/);
  assert.match(policy, /chrome_screenshot.*explicit path outside Git/);
  assert.match(tools.get('web_search').definition.description, /preferred available browser/);
  const settings = JSON.parse(await readFile(join(root, 'pi/settings.json'), 'utf8'));
  assert.ok(settings.packages.includes('npm:pi-chrome@0.15.49'));
});

test('installed stock Chrome package requires approval and preserves fallback tools on revoke', {
  skip: !existsSync(chromePath),
}, async t => {
  // Only load factories and exercise local authorization with a mock UI. Never start
  // the bridge, install a companion, or touch the real browser/profile in this test.
  clearExtensionCache();
  const loaded = await loadExtensionsCached([webPath, chromePath], root);
  const chrome = loaded.extensions.find(extension => extension.commands.has('chrome'));
  assert.deepEqual(loaded.errors, []);
  assert.ok(chrome, 'stock /chrome command loads');
  const pkg = JSON.parse(await readFile(join(chromeRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.15.49');
  let active = ['web_search', 'web_browse'];
  let approved = false;
  const messages = [];
  loaded.runtime.getActiveTools = () => [...active];
  loaded.runtime.setActiveTools = names => { active = [...names]; };
  loaded.runtime.sendMessage = message => messages.push(message);
  const ctx = { cwd: root, hasUI: true, ui: {
    confirm: async () => approved, notify() {}, setStatus() {}, theme: { fg: (_color, text) => text },
  } };
  t.after(async () => {
    try {
      await chrome.commands.get('chrome').handler('revoke', ctx);
      for (const handler of chrome.handlers.get('session_shutdown') ?? []) await handler({ reason: 'quit' }, ctx);
    } finally { loaded.runtime.invalidate(); clearExtensionCache(); }
  });
  const command = args => chrome.commands.get('chrome').handler(args, ctx);
  assert.equal(chrome.tools.size, 0, 'tools are not exposed merely by installing the package');
  await command('authorize 15m');
  assert.deepEqual(active, ['web_search', 'web_browse'], 'declined approval changes nothing');
  approved = true;
  await command('authorize 15m');
  assert.ok(active.includes('chrome_navigate') && active.includes('chrome_snapshot'));
  assert.ok(active.includes('web_browse') && active.includes('web_search'));
  const launch = chrome.tools.get('chrome_launch').definition;
  const health = await launch.execute('fixture', {}, undefined, undefined, ctx);
  assert.equal(health.details.status.connected, false, 'authorization alone is not connectivity');
  await assert.rejects(chrome.tools.get('chrome_tab').definition.execute('fixture', { action: 'activate' }, undefined, undefined, ctx), /blocked by background mode/);
  await command('revoke');
  assert.deepEqual(active, ['web_search', 'web_browse']);
  await assert.rejects(chrome.tools.get('chrome_snapshot').definition.execute('fixture', {}, undefined, undefined, ctx), /Chrome control locked/);
  assert.ok(messages.some(message => message.details?.action === 'authorized'));
  assert.ok(messages.some(message => message.details?.action === 'revoked'));
});
