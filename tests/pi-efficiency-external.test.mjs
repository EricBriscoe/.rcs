import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { externalUsageDelta, summarizerModel } from '../pi/extensions/efficiency/external.ts';

test('external usage deltas are computed against the last cumulative update per source', () => {
  const first = externalUsageDelta(undefined, { source: 'pi-condense', inputTokens: 900, outputTokens: 120, totalCost: 0.0003 });
  assert.deepEqual(first, { input: 900, output: 120, cost: 0.0003 });
  const second = externalUsageDelta({ input: 900, output: 120, cost: 0.0003 }, { source: 'pi-condense', inputTokens: 1500, outputTokens: 200, totalCost: 0.0005 });
  assert.deepEqual(second, { input: 600, output: 80, cost: 0.0002 });
  const reset = externalUsageDelta({ input: 900, output: 120, cost: 0.0003 }, { source: 'pi-condense', inputTokens: 100, outputTokens: 10, totalCost: 0.00001 });
  assert.deepEqual(reset, { input: 100, output: 10, cost: 0.00001 }, 'a lower cumulative means the source restarted its baseline');
});

test('the summarizer model comes from contextPrune settings, else the session model', () => {
  assert.deepEqual(summarizerModel({ contextPrune: { summarizerModel: 'openai-codex/gpt-5.6-luna' } }, { provider: 'openai-codex', id: 'gpt-6-astra' }), { provider: 'openai-codex', model: 'gpt-5.6-luna' });
  assert.deepEqual(summarizerModel({ contextPrune: { summarizerModel: 'default' } }, { provider: 'openai-codex', id: 'gpt-6-astra' }), { provider: 'openai-codex', model: 'gpt-6-astra' });
  assert.deepEqual(summarizerModel({}, undefined), { provider: 'unknown', model: 'unknown' });
});

test('the efficiency extension records pi-condense cost events as external-usage session entries', { timeout: 30_000 }, async t => {
  const packageDir = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
  const { clearExtensionCache, loadExtensionsCached } = await import(pathToFileURL(join(packageDir, 'dist/core/extensions/loader.js')).href);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi external usage ')));
  const agent = join(root, 'agent'); await mkdir(agent);
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ contextPrune: { summarizerModel: 'openai-codex/gpt-5.6-luna' } }));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  const handlers = new Map();
  const bus = { on(channel, handler) { handlers.set(channel, [...(handlers.get(channel) ?? []), handler]); return () => {}; }, emit(channel, data) { for (const handler of handlers.get(channel) ?? []) handler(data); } };
  clearExtensionCache();
  const loaded = await loadExtensionsCached([fileURLToPath(new URL('../pi/extensions/efficiency/index.ts', import.meta.url))], root, bus);
  assert.deepEqual(loaded.errors, []);
  const entries = []; loaded.runtime.appendEntry = (type, data) => entries.push([type, data]);
  const ctx = { cwd: root, hasUI: false, isProjectTrusted: () => true, sessionManager: { getSessionId: () => 'fixture' }, model: { provider: 'openai-codex', id: 'gpt-6-astra' } };
  const emit = async (type, extra = {}) => { for (const handler of loaded.extensions[0].handlers.get(type) || []) await handler({ type, ...extra }, ctx); };
  t.after(async () => { await emit('session_shutdown'); loaded.runtime.invalidate(); clearExtensionCache(); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
  await emit('session_start');
  bus.emit('cost:external', { source: 'pi-condense', inputTokens: 900, outputTokens: 120, totalCost: 0.0003 });
  bus.emit('cost:external', { source: 'pi-condense', inputTokens: 900, outputTokens: 120, totalCost: 0.0003 });
  bus.emit('cost:external', { source: 'pi-condense', inputTokens: 1500, outputTokens: 200, totalCost: 0.0005 });
  const usage = entries.filter(([type]) => type === 'external-usage').map(([, data]) => data);
  assert.deepEqual(usage, [
    { source: 'pi-condense', provider: 'openai-codex', model: 'gpt-5.6-luna', usage: { input: 900, output: 120, cacheRead: 0, cacheWrite: 0, cost: 0.0003 } },
    { source: 'pi-condense', provider: 'openai-codex', model: 'gpt-5.6-luna', usage: { input: 600, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0.0002 } },
  ], 'one entry per real delta; an unchanged update writes nothing');
});
