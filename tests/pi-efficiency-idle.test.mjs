import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { idleCompactionDecision, idleCompactionSettings } from '../pi/extensions/efficiency/idle.ts';

const base = { idleMs: 11 * 60_000, thresholdMs: 10 * 60_000, tokens: 50_000, minTokens: 30_000, agentIdle: true, pendingMessages: false, prunerAvailable: true };

test('idle compaction fires only once the provider cache is presumed gone', () => {
  assert.equal(idleCompactionDecision(base).compact, true);
  assert.equal(idleCompactionDecision({ ...base, idleMs: 9 * 60_000 }).compact, false);
});

test('idle compaction skips small contexts, busy agents, queued messages, and missing pruner', () => {
  assert.match(idleCompactionDecision({ ...base, tokens: 20_000 }).reason, /context 20000 below 30000/);
  assert.match(idleCompactionDecision({ ...base, tokens: null }).reason, /unknown context/);
  assert.match(idleCompactionDecision({ ...base, agentIdle: false }).reason, /agent busy/);
  assert.match(idleCompactionDecision({ ...base, pendingMessages: true }).reason, /queued messages/);
  assert.match(idleCompactionDecision({ ...base, prunerAvailable: false }).reason, /pi-condense not loaded/);
  assert.match(idleCompactionDecision(base).reason, /idle 11m/);
});

test('settings default to ten minutes and 30K tokens, and zero minutes disables', () => {
  assert.deepEqual(idleCompactionSettings({}), { enabled: true, thresholdMs: 10 * 60_000, minTokens: 30_000 });
  assert.deepEqual(idleCompactionSettings({ efficiency: { idleCompactMinutes: 0.5, idleCompactMinTokens: 1000 } }), { enabled: true, thresholdMs: 30_000, minTokens: 1000 });
  assert.equal(idleCompactionSettings({ efficiency: { idleCompactMinutes: 0 } }).enabled, false);
  assert.equal(idleCompactionSettings({ efficiency: { idleCompactMinutes: 'soon' } }).thresholdMs, 10 * 60_000);
});

test('the efficiency extension dispatches /pruner compact after the idle threshold', { timeout: 30_000 }, async t => {
  const packageDir = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
  const { clearExtensionCache, loadExtensionsCached } = await import(pathToFileURL(join(packageDir, 'dist/core/extensions/loader.js')).href);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi idle compact ')));
  const agent = join(root, 'agent'); await mkdir(agent);
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ efficiency: { idleCompactMinutes: 0.002, idleCompactMinTokens: 1000 } }));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  clearExtensionCache();
  const loaded = await loadExtensionsCached([fileURLToPath(new URL('../pi/extensions/efficiency/index.ts', import.meta.url))], root);
  assert.deepEqual(loaded.errors, []);
  const sent = [], entries = [];
  loaded.runtime.sendUserMessage = (text, options) => sent.push([text, options]);
  loaded.runtime.appendEntry = (type, data) => entries.push([type, data]);
  loaded.runtime.getCommands = () => [{ name: 'pruner', source: 'extension' }];
  let idle = true;
  const ctx = { cwd: root, hasUI: false, isProjectTrusted: () => true, isIdle: () => idle, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 5000, contextWindow: 272000 }), sessionManager: { getSessionId: () => 'fixture' }, model: { provider: 'openai-codex', id: 'gpt-6-astra' } };
  const emit = async (type, extra = {}) => { for (const handler of loaded.extensions[0].handlers.get(type) || []) await handler({ type, ...extra }, ctx); };
  t.after(async () => { await emit('session_shutdown'); loaded.runtime.invalidate(); clearExtensionCache(); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
  await emit('session_start');
  await emit('agent_settled');
  await delay(400);
  assert.deepEqual(sent, [['/pruner compact', { expandPromptTemplates: true }]]);
  assert.equal(entries.filter(([type]) => type === 'cache-idle-compact').length, 1);
  // A new run cancels the timer; a busy agent at fire time does nothing.
  await emit('agent_settled'); await emit('agent_start'); await delay(400);
  assert.equal(sent.length, 1, 'agent_start cancels a pending idle compaction');
  idle = false; await emit('agent_settled'); await delay(400);
  assert.equal(sent.length, 1, 'busy agent at fire time is skipped');
});
