import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const packageDir = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const { clearExtensionCache, loadExtensionsCached } = await import(pathToFileURL(join(packageDir, 'dist/core/extensions/loader.js')).href);
const base = fileURLToPath(new URL('../pi/', import.meta.url));
const server = fileURLToPath(new URL('./fixtures/lsp-server.mjs', import.meta.url));

async function fixture(t, trusted = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi nav integration ')));
  const source = join(root, 'checkout/pi'), agent = join(root, 'agent'), cwd = join(root, 'project');
  await cp(base, source, { recursive: true }); await mkdir(agent); await mkdir(cwd);
  const settings = JSON.parse(await readFile(join(source, 'settings.json'), 'utf8'));
  settings.packages = [];
  await writeFile(join(source, 'settings.json'), JSON.stringify(settings));
  await symlink(join(source, 'settings.json'), join(agent, 'settings.json'));
  await writeFile(join(source, 'code-navigation.json'), JSON.stringify({ astGrepVersion: 'fixture', servers: { fixture: { command: [process.execPath, server, '--pid-file', join(root, 'lsp.pid')], languages: { '.ts': 'typescript' } } } }));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  let loaded, active = ['read', 'bash', 'edit', 'write', 'code_nav', 'code_search'];
  const notices = [], approvals = [];
  const ctx = { cwd, hasUI: true, isProjectTrusted: () => trusted, ui: { notify: (...args) => notices.push(args), confirm: async (...args) => { approvals.push(args); return false; } } };
  async function emit(type, extra = {}) {
    let result;
    for (const handler of loaded.extensions[0].handlers.get(type) || []) result = await handler({ type, ...extra }, ctx) ?? result;
    return result;
  }
  async function load() {
    clearExtensionCache(); loaded = await loadExtensionsCached([join(source, 'extensions/code-navigation/index.ts')], cwd);
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.getActiveTools = () => active;
    loaded.runtime.setActiveTools = value => { active = value; };
    await emit('session_start');
  }
  t.after(async () => {
    try { if (loaded) await emit('session_shutdown'); }
    finally { loaded?.runtime.invalidate(); clearExtensionCache(); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); }
  });
  await load();
  return { root, source, agent, cwd, ctx, notices, approvals, emit, active: () => active,
    tool: (params, signal) => loaded.extensions[0].tools.get('code_nav').definition.execute('fixture', params, signal, undefined, ctx),
    structural: params => loaded.extensions[0].tools.get('code_search').definition.execute('fixture', params, undefined, undefined, ctx),
    command: args => loaded.extensions[0].commands.get('code-nav').handler(args, ctx),
    reload: async () => { await emit('session_shutdown'); loaded.runtime.invalidate(); await load(); },
  };
}

test('native first-visit instructions assess every relevant language, persist completion, and recheck on reload', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'main.ts'), 'function alpha() {}\nalpha();\n');
  await writeFile(join(f.cwd, 'README.md'), 'Fixture docs');
  assert.ok(f.active().includes('grep') && f.active().includes('find') && f.active().includes('ls'));
  const first = await f.emit('before_agent_start', { systemPrompt: 'BASE' });
  assert.match(first.systemPrompt, /First-visit code navigation setup/);
  assert.match(first.systemPrompt, /all relevant languages\/subprojects/);
  await f.tool({ action: 'setup', recipe: 'fixture' });
  const result = await f.tool({ action: 'definition', path: 'main.ts', line: 2, column: 1 });
  assert.equal(JSON.parse(result.content[0].text).result.locations[0].line, 1);
  await assert.rejects(f.tool({ action: 'assess', summary: 'incomplete' }), /\.md/);
  await f.tool({ action: 'assess', summary: 'TS verified, Markdown is documentation', skipped: [{ extension: '.md', reason: 'Documentation only' }] });
  assert.equal(await f.emit('before_agent_start', { systemPrompt: 'BASE' }), undefined);
  const oldPid = Number(await readFile(join(f.root, 'lsp.pid'), 'utf8'));
  await f.reload();
  assert.throws(() => process.kill(oldPid, 0), error => error.code === 'ESRCH', 'reload stopped the previous server');
  assert.equal(await f.emit('before_agent_start', { systemPrompt: 'BASE' }), undefined);
  await writeFile(join(f.cwd, 'extra.py'), 'def new_language(): pass');
  assert.match((await f.emit('before_agent_start', { systemPrompt: 'BASE' })).systemPrompt, /First-visit/);
  await f.command('reassess'); assert.ok(f.notices.some(([text]) => /next agent turn/.test(text)));
});

test('pin changes and missing executables invalidate a completed assessment', async t => {
  const f = await fixture(t), localServer = join(f.root, 'custom-lsp.mjs');
  await cp(server, localServer);
  await writeFile(join(f.cwd, 'main.ts'), 'function alpha() {}');
  f.ctx.ui.confirm = async () => true;
  await f.tool({ action: 'configure', server: 'custom', command: [process.execPath, localServer], version: 'fixture', languages: [{ extension: '.ts', languageId: 'typescript' }] });
  await f.tool({ action: 'assess', summary: 'Fixture server verified' });
  assert.equal(await f.emit('before_agent_start', { systemPrompt: 'BASE' }), undefined);
  const pinsPath = join(f.source, 'code-navigation.json');
  const pins = JSON.parse(await readFile(pinsPath, 'utf8'));
  pins.astGrepVersion = 'changed-fixture-pin';
  await writeFile(pinsPath, JSON.stringify(pins)); await f.reload();
  assert.match((await f.emit('before_agent_start', { systemPrompt: 'BASE' })).systemPrompt, /First-visit/);
  await f.tool({ action: 'assess', summary: 'New pins reviewed' });
  await rm(localServer);
  const status = JSON.parse((await f.tool({ action: 'status' })).content[0].text);
  assert.equal(status.needsAssessment, true); assert.deepEqual(status.unavailableServers, ['custom']);
});

test('untrusted projects do not scan/create state; custom and additional-root approval cannot be guessed', async t => {
  const f = await fixture(t, false);
  assert.equal(await f.emit('before_agent_start', { systemPrompt: 'BASE' }), undefined);
  await assert.rejects(f.tool({ action: 'status' }), /trusted/);
  assert.equal(existsSync(join(f.agent, 'code-navigation')), false);
  f.ctx.isProjectTrusted = () => true;
  await assert.rejects(f.tool({ action: 'configure', server: 'custom', command: [process.execPath, server], version: 'fixture', languages: [{ extension: '.ts', languageId: 'typescript' }] }), /not approved/);
  assert.equal(f.approvals.length, 1);
  await assert.rejects(f.tool({ action: 'setup', recipe: 'fixture', initializationOptions: { plugins: [{ name: 'unapproved', location: f.cwd }] } }), /not approved/);
  await mkdir(join(f.root, 'other'));
  await assert.rejects(f.tool({ action: 'status', root: join(f.root, 'other') }), /not approved/);
  f.ctx.ui.confirm = async () => true;
  await f.tool({ action: 'status', root: join(f.root, 'other') });
  f.ctx.ui.confirm = async () => { throw Error('Already-approved root should not ask again'); };
  await f.tool({ action: 'status', root: join(f.root, 'other') });
});

test('native-loaded structural tool executes its pinned binary and isolated config', { skip: process.env.PI_CODE_NAV_LIVE !== '1', timeout: 180000 }, async t => {
  const f = await fixture(t);
  const pins = JSON.parse(await readFile(join(base, 'code-navigation.json'), 'utf8'));
  await writeFile(join(f.source, 'code-navigation.json'), JSON.stringify(pins));
  await writeFile(join(f.cwd, 'main.ts'), 'console.log("fixture");\n');
  await writeFile(join(f.cwd, 'sgconfig.yml'), ': invalid repository config [');
  const result = JSON.parse((await f.structural({ language: 'typescript', pattern: 'console.log($$$ARGS)' })).content[0].text);
  assert.equal(result.matches[0].path, 'main.ts');
});

test('actual Pi CLI loads native navigation, activates built-in search, and honors explicit tool restrictions', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const output = join(f.root, 'probe.json'), probe = join(f.root, 'probe.ts');
  await writeFile(probe, `import {writeFileSync} from 'node:fs'; export default function(pi) { pi.registerCommand('nav-probe',{description:'fixture',handler:async()=>{writeFileSync(${JSON.stringify(output)}, JSON.stringify(pi.getActiveTools()));}}); }`);
  for (const flags of [[], ['--tools', 'read']]) {
    const args = ['--offline', '--no-session', '--approve', '--no-context-files', '--no-extensions', '-e', join(f.source, 'extensions/code-navigation/index.ts'), ...flags, '-e', probe, '-p', '/nav-probe'];
    const pending = promisify(execFile)(process.execPath, [join(packageDir, 'dist/cli.js'), ...args], { cwd: f.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: f.agent }, timeout: 20000 });
    pending.child.stdin.end(); await pending;
    const tools = JSON.parse(await readFile(output, 'utf8'));
    if (flags.length) assert.deepEqual(tools, ['read']);
    else for (const tool of ['grep', 'find', 'ls', 'code_nav', 'code_search']) assert.ok(tools.includes(tool), `${tool} active`);
  }
});
