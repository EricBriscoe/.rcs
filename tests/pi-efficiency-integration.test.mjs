import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { usageReport } from '../pi/extensions/efficiency/usage.ts';

const pkg = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const { loadExtensionsCached, clearExtensionCache } = await import(pathToFileURL(join(pkg, 'dist/core/extensions/loader.js')));
const { createBashTool } = await import(pathToFileURL(join(pkg, 'dist/core/tools/bash.js')));
const { createGrepTool } = await import(pathToFileURL(join(pkg, 'dist/core/tools/grep.js')));
const source = fileURLToPath(new URL('../pi/extensions/efficiency/index.ts', import.meta.url));
const raw = Array.from({ length: 100 }, (_, i) => `✔ passing test ${i} (1.234ms)`).join('\n') + '\nℹ tests 100\nℹ fail 0\n';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi efficiency native ')), agent = join(root, 'agent'), cwd = join(root, 'project');
  await mkdir(agent); await mkdir(cwd);
  const previous = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = agent;
  delete process.env.RTK_DISABLED;
  delete process.env.NODE_TEST_CONTEXT; // A nested test CLI must run, not inherit the outer runner marker.
  const ctx = { cwd, isProjectTrusted: () => true, model: { id: 'fixture', provider: 'fixture' }, sessionManager: { getSessionId: () => 'foreground' }, ui: { notify: () => {} } };
  let loaded;
  async function emit(type, event = {}) {
    let result;
    for (const handler of loaded.extensions[0].handlers.get(type) || []) result = await handler({ type, ...event }, ctx) ?? result;
    return result;
  }
  async function load() { clearExtensionCache(); loaded = await loadExtensionsCached([source], cwd); assert.deepEqual(loaded.errors, []); await emit('session_start'); }
  t.after(async () => {
    if (loaded) { await emit('session_shutdown'); loaded.runtime.invalidate(); }
    clearExtensionCache();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  });
  await load();
  return { root, agent, cwd, ctx, emit, command: (name, args) => loaded.extensions[0].commands.get(name).handler(args, ctx), reload: async () => { await emit('session_shutdown'); loaded.runtime.invalidate(); await load(); } };
}
const event = (command = 'node --test', text = raw) => ({ toolName: 'bash', input: { command }, isError: false, content: [{ type: 'text', text }], details: {} });

test('native Bash executes once; reduction preserves raw output, side effects and error semantics', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'once.mjs'), `import {appendFileSync} from 'node:fs';appendFileSync('effects','once\\n');console.log(${JSON.stringify(raw)});`);
  const bash = createBashTool(f.cwd);
  // Use an actual test process with a side effect; force spec output for deterministic pass-line formatting.
  const command = 'node --test --test-reporter=spec once.mjs';
  const result = await bash.execute('real', { command }, new AbortController().signal);
  const reduced = await f.emit('tool_result', { ...event(command), ...result });
  assert.ok(reduced, JSON.stringify(result));
  assert.equal(await readFile(join(f.cwd, 'effects'), 'utf8'), 'once\n');
  assert.equal(await readFile(reduced.details.fullOutputPath, 'utf8'), result.content[0].text);
  assert.match(reduced.content[0].text, /Raw output:/);
  assert.ok(reduced.content[0].text.length < result.content[0].text.length);
  await assert.rejects(bash.execute('failure', { command: 'printf warning; exit 7' }, new AbortController().signal), /code 7/);
  assert.equal(await f.emit('tool_result', { ...event(), isError: true }), undefined);
  assert.equal(await f.emit('tool_result', { ...event(), toolName: 'read' }), undefined);
  assert.equal(await f.emit('tool_result', event('# pi:raw\nnode --test')), undefined);
  await f.command('output', 'raw'); assert.equal(await f.emit('tool_result', event()), undefined);
  await f.reload(); assert.ok(await f.emit('tool_result', event()));
  f.ctx.isProjectTrusted = () => false; assert.equal(await f.emit('tool_result', event()), undefined);
});

test('filter absence/errors keep raw results without rerunning; native full logs remain recoverable', async t => {
  const f = await fixture(t), config = join(f.root, 'pi');
  await mkdir(config); await writeFile(join(config, 'settings.json'), '{}'); await writeFile(join(config, 'rtk.json'), '{"version":"0.48.0"}');
  await symlink(join(config, 'settings.json'), join(f.agent, 'settings.json'));
  const diff = 'diff --git a/file b/file\n' + '+long line to filter\n'.repeat(100);
  assert.equal(await f.emit('tool_result', event('git diff', diff)), undefined);
  const dir = join(f.agent, 'tooling/rtk/0.48.0'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'rtk'), '#!/bin/sh\ncat >/dev/null\nprintf "compact diff\\n"\n', { mode: 0o700 });
  const reduced = await f.emit('tool_result', event('git diff', diff));
  assert.match(reduced.content[0].text, /Reduced: rtk:git-diff/);
  assert.equal(await readFile(reduced.details.fullOutputPath, 'utf8'), diff);
  await writeFile(join(dir, 'rtk'), '#!/bin/sh\ncat >/dev/null\nprintf warning >&2\nexit 2\n');
  assert.equal(await f.emit('tool_result', event('git diff', diff)), undefined);
  const full = join(f.root, 'native-full.log'); await writeFile(full, raw);
  const withLog = await f.emit('tool_result', { ...event('node --test', raw.slice(-1800)), details: { fullOutputPath: full } });
  assert.ok(withLog); assert.equal(await readFile(withLog.details.fullOutputPath, 'utf8'), raw);
  assert.equal(await readFile(full, 'utf8'), raw);
});

test('search reduction retains every match and line number with an exact raw artifact', async t => {
  const f = await fixture(t);
  const file = 'src/a-very-long-directory-name/another-long-component-name/example.ts';
  const matches = Array.from({ length: 60 }, (_, i) => `${file}:${i + 1}: match ${i}: retain exact text  `);
  const text = matches.join('\n');
  const search = { toolName: 'grep', input: { pattern: 'match', context: 0 }, isError: false, content: [{ type: 'text', text }], details: {} };
  const reduced = await f.emit('tool_result', search);
  assert.ok(reduced, 'native grep should group repeated paths');
  const shown = reduced.content[0].text;
  assert.match(shown, /Reduced: grouped-grep/);
  assert.equal(shown.split(file).length - 1, 1);
  for (let i = 0; i < 60; i++) assert.ok(shown.includes(`${i + 1}: match ${i}: retain exact text  \n`), `match ${i} retained verbatim`);
  assert.equal(await readFile(reduced.details.fullOutputPath, 'utf8'), text);
  assert.ok(Buffer.byteLength(shown) < Buffer.byteLength(text) / 2);
  assert.equal(search.content[0].text, text, 'input remains unchanged');
  const shell = await f.emit('tool_result', event('rg -n match src', text));
  assert.match(shell.content[0].text, /Reduced: grouped-grep/, 'shell searches must not use a lossy RTK filter');
  for (const changed of [
    { input: { pattern: 'match', context: 2 } },
    { isError: true },
    { details: { matchLimitReached: 60 } },
    { details: { linesTruncated: true } },
    { details: { truncation: { truncated: true } } },
    { content: [{ type: 'text', text: text + '\n\n[Match limit reached]' }] },
    { content: [{ type: 'text', text }, { type: 'image', data: 'unchanged' }] },
  ]) assert.equal(await f.emit('tool_result', { ...search, ...changed }), undefined);
  await f.command('output', 'raw');
  assert.equal(await f.emit('tool_result', search), undefined);
});

test('installed native grep remains searchable and truncated results keep their notices', async t => {
  const f = await fixture(t);
  const name = 'a-long-source-filename-with-important-matches-and-whitespace.ts';
  const source = Array.from({ length: 40 }, (_, i) => `const match${i} = ${i};  `).join('\n');
  await writeFile(join(f.cwd, name), source);
  const grep = createGrepTool(f.cwd);
  const input = { pattern: 'match', path: f.cwd, limit: 100 };
  const original = await grep.execute('native-grep', input, new AbortController().signal);
  const reduced = await f.emit('tool_result', { ...original, input, toolName: 'grep', isError: false });
  assert.ok(reduced);
  assert.equal(await readFile(reduced.details.fullOutputPath, 'utf8'), original.content[0].text);
  for (let i = 0; i < 40; i++) assert.ok(reduced.content[0].text.includes(`${i + 1}: const match${i} = ${i};  \n`));
  const limited = await grep.execute('limited-grep', { ...input, limit: 20 }, new AbortController().signal);
  assert.match(limited.content[0].text, /limit/i);
  assert.equal(await f.emit('tool_result', { ...limited, input, toolName: 'grep', isError: false }), undefined);
  assert.equal(await readFile(join(f.cwd, name), 'utf8'), source);
});

test('session usage is independent and summary events are deduplicated', async t => {
  const f = await fixture(t);
  const reduced = await f.emit('tool_result', event());
  assert.ok(reduced.details.fullOutputPath.startsWith(join(f.agent, 'efficiency/output/')));
  const usage = { input: 10, output: 5, cacheRead: 100, totalTokens: 115 };
  await f.emit('message_end', { message: { role: 'assistant', provider: 'fixture', model: 'model', usage } });
  for (let i = 0; i < 2; i++) await f.emit('session_compact', { compactionEntry: { id: 'compact-id', usage } });
  await f.emit('session_tree', { summaryEntry: { id: 'branch-id', usage } });
  const report = usageReport(f.agent, 'foreground');
  assert.deepEqual(report.models.map(m => m.category), ['branch-summary', 'compaction', 'foreground']);
  assert.equal(report.models[1].calls, 1);
  assert.equal(usageReport(f.agent, 'other-session').models.length, 0);
});
