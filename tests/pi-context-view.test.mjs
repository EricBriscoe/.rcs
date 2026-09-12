import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const host = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const { loadExtensionsCached, clearExtensionCache } = await import(pathToFileURL(join(host, 'dist/core/extensions/loader.js')));

test('context inspector is configured unpinned for the existing package updater', async () => {
  const settings = JSON.parse(await readFile(new URL('../pi/settings.json', import.meta.url), 'utf8'));
  assert.ok(settings.packages.includes('npm:pi-context-view'));
  assert.equal(settings.defaultModel, 'gpt-6-astra');
  assert.equal(settings.defaultThinkingLevel, 'high');
});

test('installed context inspector observes real turns without changing context, tools, or usage', async t => {
  const agent = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
  const entry = join(agent, 'npm/node_modules/pi-context-view/src/index.ts');
  const loaded = await loadExtensionsCached([entry], process.cwd());
  t.after(() => { loaded.runtime.invalidate(); clearExtensionCache(); });
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.getAllTools = () => [];
  loaded.runtime.getActiveTools = () => [];
  loaded.runtime.getCommands = () => [];
  loaded.runtime.sendUserMessage = () => assert.fail('real turns must not trigger a probe');
  const extension = loaded.extensions[0];
  assert.ok(extension.commands.has('context'));
  assert.equal(extension.tools.size, 0, 'no extra tool definitions');
  const messages = [{ role: 'user', content: 'Inspect a source file', timestamp: 1 }];
  const entries = [{ type: 'message', id: 'first', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: messages[0] }];
  const originalMessages = structuredClone(messages);
  const context = {
    mode: 'rpc', hasUI: true,
    sessionManager: { getEntries: () => entries, getLeafId: () => 'first' },
    getSystemPrompt: () => 'Keep source and diagnostics exact.',
    abort: () => assert.fail('a real turn must not be aborted'),
    ui: { notify: () => {} },
  };
  async function emit(type, data) {
    for (const handler of extension.handlers.get(type) || []) {
      assert.equal(await handler({ type, ...data }, context), undefined, `${type} must remain observational`);
    }
  }
  await emit('session_start', {});
  await emit('input', { source: 'interactive', text: 'Inspect a source file' });
  await emit('before_agent_start', { prompt: 'Inspect a source file', systemPrompt: context.getSystemPrompt(), systemPromptOptions: { cwd: process.cwd(), selectedTools: [], contextFiles: [], skills: [] } });
  await emit('turn_start', {});
  await emit('context', { messages });
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'Original answer' }], timestamp: 2, usage: { input: 7, output: 3, cacheRead: 10 } };
  await emit('message_end', { message: assistant });
  assert.deepEqual(messages, originalMessages);
  assert.equal(assistant.content[0].text, 'Original answer');
  assert.deepEqual(assistant.usage, { input: 7, output: 3, cacheRead: 10 });
  await extension.commands.get('context').handler('usage', context); // TUI-only refusal, no model call.
  await emit('session_shutdown', {});
});
