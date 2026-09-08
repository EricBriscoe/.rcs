import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MemoryStore } from '../pi/extensions/memory/store.ts';
import { GLOBAL_SCOPE, parseCandidates, memoryContext } from '../pi/extensions/memory/policy.ts';
import { normalizedText, RETENTION, DAY } from '../pi/extensions/memory/consolidation.ts';
import { Learner } from '../pi/extensions/memory/learner.ts';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi consolidation ')); let now = 100 * DAY;
  const path = join(dir, 'memory.sqlite'), db = new MemoryStore(path, () => now);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, path, tick: (ms = 1) => now += ms };
}
const note = (topic, text, entry = topic) => ({ topic, text, kind: 'decision', keywords: 'package manager dependencies', sources: [{ session: 'old', entry, role: 'user', quote: text }] });
function proposal(db, targets, { action = 'merge', text = 'Use pnpm for frontend dependencies; keep npm for legacy scripts.', topic = targets[0].topic, scope = 'A', entry = 'new-user' } = {}) {
  const payload = { session: entry, entries: [{ id: entry, role: 'user', text }] };
  const response = { memories: [{ action, targets: targets.map(({ id, revision }) => ({ id, revision })), reason: 'Explicit new user evidence concerns the same package-manager preference.', topic, text, kind: 'decision', keywords: 'package manager', evidence: [{ entry, quote: text.slice(0, 240) }] }] };
  db.enqueue(scope, payload);
  return { job: db.claim(scope, 'quota'), candidate: parseCandidates(JSON.stringify(response), payload, targets)[0], response, payload };
}
function apply(db, targets, options) {
  const { job, candidate } = proposal(db, targets, options);
  return db.finish(job, [candidate], 13, targets)[0];
}

test('normalization deduplicates formatting but preserves paths, negation and identifier case', t => {
  const { db } = fixture(t);
  const original = db.save('A', note('manager', 'Use pnpm for café packages.'));
  assert.equal(db.save('A', note('alias', ' Use\t pnpm  for cafe\u0301 packages. ')).id, original.id);
  assert.equal(db.list('A').length, 1);
  assert.notEqual(normalizedText('TOKEN'), normalizedText('token'));
  assert.notEqual(normalizedText('Keep `a  b`.'), normalizedText('Keep `a b`.'));
  assert.notEqual(normalizedText('config:\n  key: value'), normalizedText('config:\nkey: value'));
  assert.notEqual(normalizedText('Use pnpm.'), normalizedText('Do not use pnpm.'));
  assert.notEqual(normalizedText('/Foo/config'), normalizedText('/foo/config'));
  assert.ok(db.save('B', note('manager', original.text)).id, 'different scopes do not deduplicate');
  assert.ok(db.save('A', note('negation', 'Do not use pnpm for café packages.')).id);
});

test('schema v3 migration preserves notes, revisions, quota reservations and queued evidence', t => {
  const { db, path, tick } = fixture(t);
  const first = db.save('A', note('manager', 'Old pnpm policy.'));
  tick(); db.save('A', note('manager', 'New pnpm policy.'));
  db.enqueue('A', { session: 's', entries: [{ id: 'u', role: 'user', text: 'Evidence' }] });
  const job = db.claim('A');
  db.db.exec(`DROP INDEX memories_normalized; DROP TABLE changes; DROP TABLE fingerprints; DROP TABLE job_totals; DROP TABLE job_receipts; DROP TABLE lineage;
    ALTER TABLE memories DROP COLUMN active; ALTER TABLE memories DROP COLUMN retired_by; PRAGMA user_version=3;`);
  db.close();
  const migrated = new MemoryStore(path, db.now);
  try {
    assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(migrated.get('A', first.id).active, 1);
    assert.equal(migrated.get('A', first.id, true).history[0].text, first.text);
    assert.equal(migrated.liveBatch(job), true);
    assert.equal(migrated.dailyBudget().used, 1);
    assert.equal(migrated.db.prepare('SELECT count(*) n FROM fingerprints').get().n, 2);
    assert.ok(migrated.search('A', 'pnpm').length);
  } finally { migrated.close(); }
});

test('add/ignore cannot overwrite an existing topic; similar entities and temporary exceptions stay separate', t => {
  const { db } = fixture(t);
  const first = db.save('A', note('prod', 'Use pnpm for production.'));
  function save(candidate) { return db.transaction(() => db.consolidateInside('A', candidate, db.now(), 0)); }
  assert.equal(save({ ...note('prod', 'Use npm for production.'), consolidation: { action: 'add', targets: [] } }).skipped, 'existing-topic');
  assert.equal(save({ ...note('duplicate', first.text), consolidation: { action: 'ignore', targets: [] } }).skipped, 'redundant');
  assert.ok(save({ ...note('scratch', 'Use npm only for scratch experiments.'), consolidation: { action: 'add', targets: [] } }).id);
  assert.equal(db.get('A', first.id).text, first.text);
  assert.equal(db.changes('A').length, 0);
});

test('merge keeps canonical ID, all provenance, an inactive alias and an auditable undo record', t => {
  const { db, tick } = fixture(t);
  const first = db.save('A', note('manager', 'Use pnpm for frontend dependencies.'));
  const alias = db.save('A', note('legacy', 'Keep npm for legacy scripts.'));
  tick();
  const result = apply(db, [first, alias]);
  assert.equal(result.id, first.id);
  assert.deepEqual(result.retired, [alias.id]);
  const canonical = db.get('A', first.id, true);
  assert.equal(canonical.sources.length, 3);
  assert.equal(canonical.history[0].text, first.text);
  assert.equal(canonical.evidence_at, db.now());
  assert.ok(canonical.changes.some(change => change.id === result.changeId));
  assert.equal(db.get('A', alias.id).retired_by, first.id);
  assert.equal(db.get('A', alias.id).active, 0);
  assert.deepEqual(db.list('A').map(row => row.id), [first.id]);
  assert.deepEqual(db.list('A', 100, true).map(row => row.id), [alias.id]);
  assert.deepEqual(db.recall('A', 'legacy scripts').map(row => row.id), [first.id]);
  assert.equal(db.save('A', note('legacy', 'Change retired alias.')).skipped, 'retired');
  db.enqueue('A', { session: 'pending', entries: [{ id: 'u', role: 'user', text: 'Do something' }] });
  const inFlight = db.claim('A');
  const undone = db.undo('A', result.changeId);
  assert.equal(undone.manual, true);
  for (const before of [first, alias]) {
    const restored = db.get('A', before.id);
    assert.equal(restored.text, before.text); assert.equal(restored.active, 1);
    assert.equal(restored.manual, 1); assert.deepEqual(restored.sources, before.sources);
  }
  assert.deepEqual(db.finish(inFlight, [note('late', 'Late extraction')]), []);
  assert.equal(db.changes('A').length, 0);
});

test('explicit preference changes supersede a canonical revision without discarding prior evidence', t => {
  const { db, tick } = fixture(t);
  const first = db.save('A', note('manager', 'Use npm for frontend dependencies.'));
  tick();
  const result = apply(db, [first], { action: 'supersede', text: 'Use pnpm instead of npm for frontend dependencies.' });
  assert.ok(result.changeId);
  assert.equal(db.get('A', first.id).sources.length, 1);
  assert.deepEqual(db.get('A', first.id, true).history[0].sources, first.sources);
  assert.equal(db.get('A', first.id, true).history[0].text, first.text);
  assert.equal(db.list('A').length, 1);
  db.undo('A', result.changeId);
  assert.equal(db.get('A', first.id).text, first.text);
});

test('parser rejects unknown/unoffered targets, fabricated evidence, protected notes and assistant-only supersession', t => {
  const { db } = fixture(t);
  const first = db.save('A', note('manager', 'Use pnpm.'));
  const { response, payload } = proposal(db, [first]);
  assert.throws(() => parseCandidates(JSON.stringify(response), payload), /unavailable/);
  for (const mutate of [
    x => x.targets[0].revision++,
    x => x.targets.push(x.targets[0]),
    x => x.action = 'delete',
    x => x.topic = 'unrelated',
    x => x.evidence[0].quote = 'Fabricated citation',
  ]) {
    const copy = structuredClone(response); mutate(copy.memories[0]);
    assert.throws(() => parseCandidates(JSON.stringify(copy), payload, [first]));
  }
  for (const flag of ['manual', 'pinned']) assert.throws(() => parseCandidates(JSON.stringify(response), payload, [{ ...first, [flag]: 1 }]), /protected/);
  response.memories[0].action = 'supersede'; response.memories[0].kind = 'lesson'; payload.entries[0].role = 'assistant';
  assert.throws(() => parseCandidates(JSON.stringify(response), payload, [first]), /user evidence/);
});

test('current-store validation rejects cross-scope, newly pinned/manual, changed or retired targets', t => {
  const { db, tick, path } = fixture(t);
  for (const mutation of ['scope', 'pinned', 'manual', 'changed', 'retired']) {
    const scope = mutation === 'scope' ? 'B' : 'A';
    const first = db.save(scope, note('manager-' + mutation, 'Use pnpm for ' + mutation + '.'));
    tick();
    const { job, candidate } = proposal(db, [first], { entry: mutation });
    tick();
    const other = new MemoryStore(path, db.now);
    try {
      if (mutation === 'pinned') other.pin('A', first.id, true);
      if (mutation === 'manual') other.save('A', note(first.topic, 'User replacement.'), { manual: true });
      if (mutation === 'changed') other.save('A', note(first.topic, 'Newer decision.'));
      if (mutation === 'retired') other.db.prepare('UPDATE memories SET active=0 WHERE id=?').run(first.id);
    } finally { other.close(); }
    assert.equal(db.finish(job, [candidate], 1, [first])[0].skipped, 'stale-or-protected');
  }
  assert.equal(db.changes('A').length, 0);
});

test('undo is fenced by newer work and protection, cannot target another scope or a forgotten note', t => {
  const { db, tick } = fixture(t);
  for (const mutation of ['changed', 'pin', 'forget']) {
    const first = db.save('A', note('manager-' + mutation, 'Use npm for ' + mutation + '.')); tick();
    const result = apply(db, [first], { action: 'supersede', entry: mutation, text: 'Use pnpm instead for ' + mutation + '.' });
    assert.throws(() => db.undo('B', result.changeId), /not found/);
    tick();
    if (mutation === 'changed') db.save('A', note(first.topic, 'A later decision.'));
    if (mutation === 'pin') db.pin('A', first.id, true);
    if (mutation === 'forget') db.forget('A', first.id);
    assert.throws(() => db.undo('A', result.changeId), /changed|not found/);
  }
});

test('forget removes consolidated relatives, undo snapshots and histories without weakening tombstones', t => {
  const { db, tick } = fixture(t);
  const first = db.save('A', note('manager', 'Use pnpm for frontend dependencies.'));
  const alias = db.save('A', note('alias', 'Keep npm for legacy scripts.')); tick();
  const result = apply(db, [first, alias]);
  db.forget('A', alias.id);
  assert.throws(() => db.get('A', first.id), /not found/);
  assert.throws(() => db.undo('A', result.changeId), /not found/);
  assert.equal(db.db.prepare('SELECT count(*) n FROM changes').get().n, 0);
  for (const memory of [first, alias, result]) assert.equal(db.save('A', note('new-name', memory.text)).skipped, 'revoked');
});

test('forget follows consolidation lineage even after undo or manual reactivation', t => {
  const { db, tick } = fixture(t);
  for (const mode of ['undo', 'reactivate']) {
    const first = db.save('A', note('manager-' + mode, 'Use pnpm for frontend ' + mode + '.'));
    const alias = db.save('A', note('alias-' + mode, 'Keep npm for legacy ' + mode + '.')); tick();
    const result = apply(db, [first, alias], { entry: mode, text: 'Use pnpm for frontend and npm for legacy ' + mode + '.' });
    if (mode === 'undo') db.undo('A', result.changeId);
    else db.save('A', note(alias.topic, 'User changed the alias.'), { manual: true });
    db.forget('A', alias.id);
    assert.throws(() => db.get('A', first.id), /not found/);
    assert.equal(db.db.prepare('SELECT count(*) n FROM lineage').get().n, 0);
    assert.equal(db.save('A', note('new-name', result.text)).skipped, 'revoked');
  }
});

test('retention bounds revisions, undo windows and terminal jobs without resetting budgets, tokens or dedup receipts', t => {
  const { db, tick } = fixture(t);
  const first = db.save('A', note('history', 'Initial preference.'));
  for (let i = 0; i < 30; i++) { tick(); db.save('A', note('history', `Preference ${i}.`)); }
  const oldPayload = { session: 'old', entries: [{ id: 'u', role: 'user', text: 'Evidence' }] };
  db.enqueue('A', oldPayload); db.finish(db.claim('A'), [], 70);
  tick(31 * DAY);
  const currentPayload = { session: 'recent', entries: [{ id: 'u', role: 'user', text: 'New evidence' }] };
  db.enqueue('A', currentPayload); const active = db.claim('A');
  const budget = db.dailyBudget().used;
  db.maintain(true);
  assert.equal(db.db.prepare('SELECT count(*) n FROM versions').get().n, RETENTION.revisions);
  assert.equal(db.db.prepare('SELECT count(*) n FROM jobs').get().n, 1);
  assert.equal(db.stats('A').learningTokens, 70);
  assert.equal(db.dailyBudget().used, budget);
  assert.equal(db.liveBatch(active), true);
  assert.equal(db.enqueue('A', oldPayload), false, 'receipt survives metadata pruning');
  db.forget('A', first.id);
  assert.equal(db.save('A', note('other-name', 'Initial preference.')).skipped, 'revoked', 'pruned revisions still leave deletion fingerprints');
  db.maintain(true); assert.equal(db.stats('A').learningTokens, 70, 'rollups are not counted twice');
});

test('maintenance never expires rare active knowledge, protected notes, archived aliases or tombstones', t => {
  const { db, tick } = fixture(t);
  const rare = db.save('A', note('rare', 'Recovery procedure for a rare database failure.'));
  const pinned = db.save('A', note('pinned', 'Rare but important preference.'), { pinned: true });
  const manual = db.save('A', note('manual', 'Manual preference.'), { manual: true });
  const global = db.save(GLOBAL_SCOPE, note('global', 'Global preference.'), { manual: true });
  tick(400 * DAY); db.maintain(true);
  for (const memory of [rare, pinned, manual, global]) assert.equal(db.get('A', memory.id).active, 1);
  assert.ok(memoryContext(db.recall('A', 'rare database')).includes(rare.text));
});

test('consolidation history is bounded and expired undo cannot silently resurrect older revisions', t => {
  const { db, tick } = fixture(t);
  let current = db.save('A', note('manager', 'Initial pnpm preference.'));
  for (let i = 0; i < 13; i++) { tick(); current = apply(db, [current], { action: 'supersede', entry: `revision-${i}`, text: `Use pnpm policy revision ${i}.` }); }
  db.maintain(true); assert.equal(db.changes('A', 100).length, RETENTION.changesPerMemory);
  const last = db.changes('A')[0].id;
  tick(91 * DAY); db.maintain(true);
  assert.equal(db.changes('A').length, 0);
  assert.throws(() => db.undo('A', last), /retention expired/);
  assert.equal(db.get('A', current.id).text, current.text);
});

test('existing budgeted learner performs consolidation in one request, not a second maintenance model call', async t => {
  const { db, tick } = fixture(t);
  const first = db.save('A', note('manager', 'Use npm for dependencies.')); tick();
  const payload = { session: 's', entries: [{ id: 'u', role: 'user', text: 'Use pnpm instead of npm for dependencies.' }] };
  db.enqueue('A', payload); let calls = 0;
  const learner = new Learner(db, 'A', async (prompt, input) => {
    calls++; assert.match(prompt, /SUPERSEDE/);
    const data = JSON.parse(input), target = data.existing.find(memory => memory.id === first.id);
    assert.equal(target.revision, first.revision); assert.ok(target.sources.length);
    return { tokens: 50, text: JSON.stringify({ memories: [{ topic: first.topic, kind: 'decision', text: payload.entries[0].text, action: 'supersede', targets: [{ id: target.id, revision: target.revision }], reason: 'Explicit user correction', evidence: [{ entry: 'u', quote: payload.entries[0].text }] }] }) };
  }, () => true, () => {});
  await learner.run(); await learner.close();
  assert.equal(calls, 1); assert.equal(db.dailyBudget().used, 1);
  assert.equal(db.get('A', first.id).text, payload.entries[0].text);
  assert.equal(db.changes('A').length, 1);
});
