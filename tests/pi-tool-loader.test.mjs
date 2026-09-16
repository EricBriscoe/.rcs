import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const packageDir = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const { clearExtensionCache, loadExtensionsCached } = await import(pathToFileURL(join(packageDir, 'dist/core/extensions/loader.js')).href);
const entry = fileURLToPath(new URL('../pi/extensions/tool-loader/index.ts', import.meta.url));

async function fixture(t, initial) {
  clearExtensionCache();
  const loaded = await loadExtensionsCached([entry], process.cwd());
  assert.deepEqual(loaded.errors, []);
  let active = [...initial];
  const registered = new Set([...initial, 'load_tools']);
  loaded.runtime.getActiveTools = () => active;
  loaded.runtime.setActiveTools = value => { active = value.filter(name => registered.has(name)); };
  loaded.runtime.getAllTools = () => [...registered].map(name => ({ name }));
  const ctx = { cwd: process.cwd(), hasUI: false, isProjectTrusted: () => true };
  async function emit(type, extra = {}) {
    let result;
    for (const handler of loaded.extensions[0].handlers.get(type) || []) result = await handler({ type, ...extra }, ctx) ?? result;
    return result;
  }
  t.after(() => { loaded.runtime.invalidate(); clearExtensionCache(); });
  await emit('session_start');
  const tool = loaded.extensions[0].tools.get('load_tools');
  assert.ok(tool, 'registers load_tools');
  return { active: () => active, load: params => tool.definition.execute('fixture', params, undefined, undefined, ctx) };
}

test('delegation tools start inactive and load_tools activates them additively', async t => {
  const f = await fixture(t, ['read', 'bash', 'subagent', 'bg_wait', 'subagent_supervisor', 'grep']);
  assert.deepEqual(f.active().sort(), ['bash', 'grep', 'load_tools', 'read']);
  const result = await f.load({ group: 'delegation' });
  assert.deepEqual(f.active().sort(), ['bash', 'bg_wait', 'grep', 'load_tools', 'read', 'subagent', 'subagent_supervisor']);
  assert.match(result.content[0].text, /subagent/);
  assert.deepEqual(result.details.loaded.sort(), ['bg_wait', 'subagent', 'subagent_supervisor']);
});

test('load_tools is idempotent and only activates registered tools', async t => {
  const f = await fixture(t, ['read', 'subagent']);
  await f.load({ group: 'delegation' });
  const again = await f.load({ group: 'delegation' });
  assert.deepEqual(f.active().sort(), ['load_tools', 'read', 'subagent']);
  assert.deepEqual(again.details.loaded, []);
  assert.match(again.content[0].text, /already active/);
});

test('load_tools rejects unknown groups and lists the known ones', async t => {
  const f = await fixture(t, ['read']);
  await assert.rejects(f.load({ group: 'nope' }), /delegation/);
});

test('explicit tool restrictions on the command line are respected', async t => {
  const previous = process.argv; process.argv = [...previous, '--tools', 'read,subagent'];
  try {
    const f = await fixture(t, ['read', 'subagent']);
    assert.deepEqual(f.active().sort(), ['read', 'subagent']);
  } finally { process.argv = previous; }
});
