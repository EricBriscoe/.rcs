import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMemoryContext, memoryContext } from '../pi/extensions/memory/policy.ts';
import { learningOutcome, memoryStatus, recallStatus } from '../pi/extensions/memory/status.ts';

const stats = { reading: 1, learning: 1, jobs: [] };

test('recall indicators distinguish empty stores, no match, disabled, and unavailable', () => {
  for (const [state, expected] of [
    ['empty', /no saved project or global notes/], ['no-match', /no matching notes/],
    ['off', /recall off/], ['unavailable', /unavailable/], ['not-run', /next prompt/],
  ]) assert.match(recallStatus({ state, count: 0 }), expected);
  assert.match(recallStatus({ state: 'recalled', count: 1 }), /Recalled 1 memory/);
  assert.match(recallStatus({ state: 'recalled', count: 3 }), /Recalled 3 memories/);
});

test('learning outcomes distinguish empty extraction, protected proposals and saved updates', () => {
  const empty = { at: 1, proposed: 0, saved: 0, skipped: {} };
  assert.match(learningOutcome(empty), /no durable memories proposed.*not an error/);
  assert.match(memoryStatus(stats, undefined, false, empty), /no durable notes/);
  const skipped = { at: 2, proposed: 2, saved: 0, skipped: { redundant: 1, manual: 1 } };
  assert.match(learningOutcome(skipped), /redundant: 1, manual: 1/);
  assert.match(memoryStatus(stats, undefined, false, skipped), /skipped all proposals/);
  assert.equal(memoryStatus(stats, undefined, false, { ...empty, proposed: 1, saved: 1 }), undefined);
  assert.match(memoryStatus({ ...stats, jobs: [{ state: 'pending', count: 1 }] },
    { allowed: false, mode: 'quota', reason: 'daily budget' }, false, empty), /paused: daily budget/);
});

test('displayed recall count and context IDs honor the character cap and retired rows', () => {
  const rows = Array.from({ length: 8 }, (_, id) => ({ id: String(id), topic: `topic/${id}`, kind: 'decision',
    text: 'x'.repeat(1600), manual: true, updated_at: 0, active: 1 }));
  const packet = buildMemoryContext(rows);
  assert.ok(packet.ids.length > 0 && packet.ids.length < rows.length);
  assert.ok(packet.content.length <= 6500);
  assert.deepEqual(packet.content.trim().split('\n').slice(1).map(line => JSON.parse(line).id), packet.ids);
  assert.equal(memoryContext(rows), packet.content);
  assert.deepEqual(buildMemoryContext(rows, 10), { content: '', ids: [] });
  assert.deepEqual(buildMemoryContext(rows.map(row => ({ ...row, active: 0 }))), { content: '', ids: [] });
});
