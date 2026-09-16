import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { pinInstructions } from '../pi/extensions/efficiency/pin.ts';

const full = 'BASE PROMPT\n\n## Memory\nnotes\n# First-visit code navigation setup\nroot';
const base = 'BASE PROMPT';

test('a fresh prompt (after before_agent_start) is accepted as the new reference', () => {
  assert.deepEqual(pinInstructions({ fresh: true, reference: full, current: base }), { instructions: base, restored: false });
});

test('a mid-run prompt that is the reference minus its tail is restored', () => {
  assert.deepEqual(pinInstructions({ fresh: false, reference: full, current: base }), { instructions: full, restored: true });
});

test('a mid-run prompt that differs in any other way is left alone', () => {
  assert.equal(pinInstructions({ fresh: false, reference: full, current: full }).restored, false);
  assert.equal(pinInstructions({ fresh: false, reference: full, current: 'OTHER' }).restored, false);
  assert.equal(pinInstructions({ fresh: false, reference: full, current: full + ' more' }).restored, false);
  assert.equal(pinInstructions({ fresh: false, reference: undefined, current: base }).restored, false);
});

test('the efficiency extension restores extension prompt additions dropped mid-run', { timeout: 30_000 }, async t => {
  const packageDir = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
  const { clearExtensionCache, loadExtensionsCached } = await import(pathToFileURL(join(packageDir, 'dist/core/extensions/loader.js')).href);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi prompt pin ')));
  const agent = join(root, 'agent'); await mkdir(agent); await writeFile(join(agent, 'settings.json'), '{}');
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  clearExtensionCache();
  const loaded = await loadExtensionsCached([fileURLToPath(new URL('../pi/extensions/efficiency/index.ts', import.meta.url))], root);
  assert.deepEqual(loaded.errors, []);
  const entries = []; loaded.runtime.appendEntry = (type, data) => entries.push([type, data]);
  const ctx = { cwd: root, hasUI: false, isProjectTrusted: () => true, sessionManager: { getSessionId: () => 'fixture' }, model: { provider: 'openai-codex', id: 'gpt-6-astra' } };
  const emit = async (type, extra = {}) => { let result; for (const handler of loaded.extensions[0].handlers.get(type) || []) result = await handler({ type, ...extra }, ctx) ?? result; return result; };
  t.after(async () => { await emit('session_shutdown'); loaded.runtime.invalidate(); clearExtensionCache(); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
  await emit('session_start');
  await emit('before_agent_start', { systemPrompt: full });
  assert.equal(await emit('before_provider_request', { payload: { instructions: full, tools: [], input: [] } }), undefined, 'fresh prompt passes through');
  const restored = await emit('before_provider_request', { payload: { instructions: base, tools: [], input: [] } });
  assert.equal(restored.instructions, full, 'dropped additions are restored mid-run');
  assert.equal(entries.filter(([type]) => type === 'cache-prompt-restored').length, 1);
  await emit('before_agent_start', { systemPrompt: base });
  assert.equal(await emit('before_provider_request', { payload: { instructions: base, tools: [], input: [] } }), undefined, 'a genuinely new prompt after before_agent_start is accepted');
});
