import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprintRequest, diagnoseCacheDrop, isCacheDrop } from '../pi/extensions/efficiency/cache.ts';

const tools = [
  { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
];
const input = [
  { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
  { type: 'function_call', name: 'read', arguments: '{"path":"a"}', call_id: '1' },
  { type: 'function_call_output', call_id: '1', output: 'file body' },
];
const payload = { model: 'gpt-6-astra', instructions: 'SYSTEM PROMPT', tools, input };
const clone = value => JSON.parse(JSON.stringify(value));

test('fingerprints are stable for identical payloads and change with the instructions', () => {
  const a = fingerprintRequest(payload), b = fingerprintRequest(clone(payload));
  assert.deepEqual(a, b);
  const changed = fingerprintRequest({ ...payload, instructions: 'SYSTEM PROMPT v2' });
  assert.notEqual(changed.instructions, a.instructions);
  assert.deepEqual(changed.toolNames, ['read', 'bash']);
  assert.equal(a.input.length, 3);
});

test('a drop is a cache read well below the previous context on a non-trivial context', () => {
  assert.equal(isCacheDrop({ previousContext: 30000, cacheRead: 4224 }), true);
  assert.equal(isCacheDrop({ previousContext: 30000, cacheRead: 22400 }), true);
  assert.equal(isCacheDrop({ previousContext: 30000, cacheRead: 29900 }), false);
  assert.equal(isCacheDrop({ previousContext: 30000, cacheRead: 31000 }), false, 'context grew normally');
  assert.equal(isCacheDrop({ previousContext: 8000, cacheRead: 0 }), false, 'tiny contexts are noise');
  assert.equal(isCacheDrop({ previousContext: 0, cacheRead: 0 }), false, 'first request');
});

test('diagnosis blames a changed system prompt', () => {
  const previous = fingerprintRequest(payload);
  const current = fingerprintRequest({ ...payload, instructions: 'SYSTEM PROMPT plus a new block' });
  const result = diagnoseCacheDrop(previous, current, { gapMs: 5000 });
  assert.equal(result.cause, 'system-prompt');
  assert.match(result.summary, /system prompt changed \(\+17 chars\)/);
});

test('diagnosis lists tool additions, removals, and schema-only changes', () => {
  const previous = fingerprintRequest(payload);
  const added = fingerprintRequest({ ...payload, tools: [...tools, { name: 'grep', description: 'x', parameters: {} }] });
  assert.equal(diagnoseCacheDrop(previous, added, { gapMs: 5000 }).cause, 'tools');
  assert.match(diagnoseCacheDrop(previous, added, { gapMs: 5000 }).summary, /tools changed: \+grep/);
  const removed = fingerprintRequest({ ...payload, tools: tools.slice(0, 1) });
  assert.match(diagnoseCacheDrop(previous, removed, { gapMs: 5000 }).summary, /tools changed: -bash/);
  const schema = fingerprintRequest({ ...payload, tools: [tools[0], { ...tools[1], description: 'Run a shell command' }] });
  assert.match(diagnoseCacheDrop(previous, schema, { gapMs: 5000 }).summary, /tool definition changed: bash/);
});

test('diagnosis reports where the conversation diverged', () => {
  const previous = fingerprintRequest(payload);
  const edited = clone(payload); edited.input[1].arguments = '{"path":"b"}'; edited.input.push({ role: 'user', content: [] });
  const result = diagnoseCacheDrop(previous, fingerprintRequest(edited), { gapMs: 5000 });
  assert.equal(result.cause, 'conversation');
  assert.match(result.summary, /conversation diverged at item 2 of 4 \(function_call read\)/);
  const truncated = clone(payload); truncated.input = truncated.input.slice(0, 2);
  assert.match(diagnoseCacheDrop(previous, fingerprintRequest(truncated), { gapMs: 5000 }).summary, /conversation shortened to 2 items \(was 3\)/);
});

test('an identical request blames the provider, mentioning idle time when relevant', () => {
  const previous = fingerprintRequest(payload);
  const current = fingerprintRequest(clone(payload));
  const quick = diagnoseCacheDrop(previous, current, { gapMs: 5000 });
  assert.equal(quick.cause, 'provider');
  assert.match(quick.summary, /request unchanged; provider-side eviction or routing \(5s since last request\)/);
  const idle = diagnoseCacheDrop(previous, current, { gapMs: 15 * 60 * 1000 });
  assert.match(idle.summary, /idle 15m/);
});

test('an appended conversation is not a divergence when only the prompt changed', () => {
  const previous = fingerprintRequest(payload);
  const grown = clone(payload); grown.instructions = 'SYSTEM PROMPT!'; grown.input.push({ role: 'user', content: [] });
  const result = diagnoseCacheDrop(previous, fingerprintRequest(grown), { gapMs: 1000 });
  assert.equal(result.cause, 'system-prompt');
});
