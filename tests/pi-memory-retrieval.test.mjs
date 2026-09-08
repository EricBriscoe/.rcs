import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { MemoryStore } from '../pi/extensions/memory/store.ts';
import { HybridRetrieval, reciprocalRankFusion } from '../pi/extensions/memory/retrieval.ts';
import { LocalEmbedding } from '../pi/extensions/memory/embedding.ts';
import { EMBEDDING_KEY, validVector } from '../pi/extensions/memory/embedding-config.mjs';
import { GLOBAL_SCOPE, memoryContext } from '../pi/extensions/memory/policy.ts';
import { Learner } from '../pi/extensions/memory/learner.ts';

const vector = (i = 0) => Array.from({ length: 384 }, (_, n) => Number(n === i));
const note = (topic, text = 'Keep explanations brief.') => ({ topic, text, keywords: '', kind: 'decision', sources: [] });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-retrieval-'));
  const path = join(root, 'memory.sqlite'), store = new MemoryStore(path);
  let allowed = true;
  const calls = [];
  const embedding = { ready: true, status: 'hybrid', start() {}, close() {}, async embed(texts) { calls.push(texts); return texts.map(() => vector()); } };
  const retrieval = new HybridRetrieval(store, embedding, 'A', () => allowed);
  store.retrieval = retrieval;
  t.after(() => { retrieval.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, path, root, retrieval, embedding, calls, untrust: () => { allowed = false; } };
}

test('RRF uses ranks, deduplicates and deterministically prefers lexical ties', () => {
  assert.deepEqual(reciprocalRankFusion(['exact', 'both', 'both'], ['paraphrase', 'both']), ['both', 'exact', 'paraphrase']);
});

test('hybrid backfills only curated fields, adds paraphrases, preserves identifiers and recall caps', async t => {
  const f = fixture(t), { store, retrieval, calls } = f;
  const saved = store.save('A', { ...note('style'), sources: [{ session: 'raw-session', entry: 'raw-id', role: 'user', quote: 'raw private evidence' }] });
  await retrieval.backfill();
  assert.deepEqual(calls[0], ['style\nKeep explanations brief.\n']);
  assert.deepEqual(store.search('A', 'terse responses'), []);
  assert.equal((await store.candidates('A', 'terse responses'))[0].id, saved.id);
  const exact = store.save('A', note('cache/e731', 'Set QZ_E731_CACHE for diagnostics.'));
  assert.equal((await store.candidates('A', 'QZ_E731_CACHE'))[0].id, exact.id, 'unembedded identifier keeps lexical tie priority');
  for (let i = 0; i < 10; i++) store.save('A', note(`pin-${i}`, 'x'.repeat(1500) + i), { manual: true, pinned: true });
  const recalled = store.recallRows('A', await store.candidates('A', 'terse responses'));
  assert.ok(recalled.length <= 8); assert.equal(recalled.filter(n => n.pinned).length, 4); assert.ok(memoryContext(recalled).length <= 6500);
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_vectors').get().n, 1, 'queries never become durable vectors');
});

test('semantic candidates enforce project/approved-global isolation before ranking; consolidation is same-scope', async t => {
  const { store, retrieval } = fixture(t);
  const local = store.save('A', note('local'));
  store.save('B', note('private', 'Employer procedure.'));
  const global = store.save(GLOBAL_SCOPE, note('global', 'Use accessible language.'), { manual: true });
  await retrieval.backfill();
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_vectors').get().n, 2);
  const recalled = await store.candidates('A', 'terse responses');
  assert.deepEqual(new Set(recalled.map(n => n.id)), new Set([local.id, global.id]));
  assert.deepEqual((await store.candidates('A', 'terse responses', 12, { purpose: 'learning' })).map(n => n.id), [local.id]);
  assert.deepEqual(await store.candidates('B', 'terse responses'), []);
  assert.deepEqual((await store.candidates(GLOBAL_SCOPE, 'terse responses')).map(n => n.id), [global.id]);
});

for (const mutation of ['update', 'forget', 'retire', 'pin', 'read off', 'learn off', 'read off-on', 'untrust', 'close']) {
  test(`late backfill and retrieval cannot revive data after ${mutation}`, async t => {
    const f = fixture(t), { store, retrieval, embedding } = f;
    const saved = store.save('A', note('style'));
    let resolve;
    embedding.embed = () => new Promise(done => { resolve = done; });
    const pending = retrieval.backfill();
    assert.ok(resolve);
    const other = new MemoryStore(f.path);
    try {
      if (mutation === 'update') other.save('A', note('style', 'Provide exhaustive detail.'));
      if (mutation === 'forget') other.forget('A', saved.id);
      if (mutation === 'retire') other.db.prepare('UPDATE memories SET active=0,revision=revision+1 WHERE id=?').run(saved.id);
      if (mutation === 'pin') other.pin('A', saved.id, true);
      if (mutation.startsWith('read')) other.setControl('A', 'reading', false);
      if (mutation === 'learn off') other.setControl('A', 'learning', false);
      if (mutation === 'read off-on') other.setControl('A', 'reading', true);
      if (mutation === 'untrust') f.untrust();
      if (mutation === 'close') retrieval.close();
    } finally { other.close(); }
    resolve([vector()]); await pending;
    assert.equal(store.db.prepare('SELECT count(*) n FROM memory_vectors').get().n, 0);
    if (mutation !== 'close' && mutation !== 'untrust') {
      embedding.embed = async () => [vector()];
      assert.deepEqual(await store.candidates('A', 'terse responses'), []);
    }
  });
}

test('forget and control toggles during query inference fence lexical and semantic results', async t => {
  const { store, retrieval, embedding, path } = fixture(t);
  const saved = store.save('A', note('style')); await retrieval.backfill();
  let resolve; embedding.embed = () => new Promise(done => { resolve = done; });
  const waiting = store.candidates('A', 'brief explanations');
  const other = new MemoryStore(path); other.forget('A', saved.id); other.close();
  resolve([vector()]); assert.deepEqual(await waiting, []);
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_vectors').get().n, 0);
});

for (const outcome of ['undefined', 'invalid', 'rejection']) {
  test(`FTS fallback fences off-on control changes during ${outcome} inference`, async t => {
    const { store, embedding, path } = fixture(t);
    store.save('A', note('style'));
    assert.equal(store.search('A', 'brief explanations').length, 1);
    let resolve, reject;
    embedding.embed = () => new Promise((done, fail) => { resolve = done; reject = fail; });
    const waiting = store.candidates('A', 'brief explanations');
    assert.ok(resolve);
    const other = new MemoryStore(path);
    try {
      other.setControl('A', 'reading', false);
      other.setControl('A', 'reading', true);
    } finally { other.close(); }
    if (outcome === 'rejection') reject(new Error('Synthetic inference failure'));
    else resolve(outcome === 'invalid' ? [[NaN]] : undefined);
    assert.deepEqual(await waiting, []);
  });
}

test('FTS fallback rechecks the epoch after lexical retrieval', async t => {
  const { store, embedding, path } = fixture(t);
  store.save('A', note('style'));
  embedding.embed = async () => undefined;
  const other = new MemoryStore(path), original = store.search.bind(store);
  store.search = (...args) => {
    const rows = original(...args);
    assert.equal(rows.length, 1);
    other.setControl('A', 'reading', false);
    other.setControl('A', 'reading', true);
    return rows;
  };
  try { assert.deepEqual(await store.candidates('A', 'brief explanations'), []); }
  finally { other.close(); }
});

test('backfill snapshots its epoch before controls when another process disables both during startup', async t => {
  const { store, retrieval, embedding, path, calls } = fixture(t);
  store.save('A', note('style'));
  const other = new MemoryStore(path);
  embedding.start = () => {
    other.setControl('A', 'reading', false);
    other.setControl('A', 'learning', false);
  };
  try { await retrieval.backfill(); }
  finally { other.close(); }
  assert.equal(store.control('A').reading, 0);
  assert.equal(store.control('A').learning, 0);
  assert.equal(calls.length, 1, 'valid inference completes across the startup interleaving');
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_vectors').get().n, 0);
});

test('revision/model/content-invalid and malformed stored vectors never authorize semantic recall', async t => {
  const { store, retrieval } = fixture(t);
  store.save('A', note('style')); await retrieval.backfill();
  const row = store.db.prepare('SELECT * FROM memory_vectors').get();
  for (const [field, value] of [['model', 'old-model'], ['revision', 0], ['digest', 'stale'], ['vector', Buffer.alloc(3)], ['vector', Buffer.alloc(384 * 4)]]) {
    store.db.prepare(`UPDATE memory_vectors SET ${field}=?`).run(value);
    assert.deepEqual(await store.candidates('A', 'terse responses'), []);
    store.db.prepare('UPDATE memory_vectors SET model=?,revision=?,digest=?,vector=?').run(row.model, row.revision, row.digest, row.vector);
  }
  const other = new MemoryStore(fixturePath(store));
  other.save('A', note('style', 'Provide exhaustive detail.')); other.close();
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_vectors').get().n, 0);
  assert.deepEqual(await store.candidates('A', 'terse responses'), []);
  function fixturePath() { return store.db.prepare('PRAGMA database_list').get().file; }
});

test('model absence, error, invalid output and negative cosine deterministically fall back to current FTS', async t => {
  const { store, retrieval, embedding } = fixture(t);
  store.save('A', note('style')); await retrieval.backfill();
  const baseline = store.search('A', 'brief explanations').map(n => n.id);
  for (const output of [undefined, [[NaN]], [vector().map(() => 0)], [vector(1)]]) {
    embedding.embed = async () => output;
    assert.deepEqual((await store.candidates('A', 'brief explanations')).map(n => n.id), baseline);
    assert.deepEqual(await store.candidates('A', 'underwater volcanoes'), []);
  }
  embedding.embed = async () => { throw Error('sensitive error text'); };
  assert.deepEqual((await store.candidates('A', 'brief explanations')).map(n => n.id), baseline);
  assert.equal(retrieval.status, 'FTS: vector index error');
  assert.ok(!validVector(vector().map(() => Infinity)));
});

test('reading and learning remain independent; untrusted/cancelled requests perform no inference', async t => {
  const { store, retrieval, embedding, calls, untrust } = fixture(t);
  store.save('A', note('style')); await retrieval.backfill();
  store.setControl('A', 'reading', false);
  assert.deepEqual(await store.candidates('A', 'terse responses'), []);
  assert.equal((await store.candidates('A', 'terse responses', 12, { purpose: 'learning' })).length, 1);
  store.setControl('A', 'learning', false);
  assert.deepEqual(await store.candidates('A', 'terse responses', 12, { purpose: 'learning' }), []);
  store.setControl('A', 'reading', true);
  const before = calls.length;
  assert.deepEqual(await store.candidates('A', 'brief', 8, { signal: AbortSignal.abort() }), []);
  untrust(); assert.deepEqual(await store.candidates('A', 'brief'), []);
  await retrieval.backfill(); assert.equal(calls.length, before);
});

test('consolidation shares semantic candidates but offered revisions and manual protections still fence updates', async t => {
  const { store, retrieval } = fixture(t);
  const saved = store.save('A', note('style')); await retrieval.backfill();
  store.enqueue('A', { session: 's', entries: [{ id: 'u', role: 'user', text: 'Prefer terse responses.' }] });
  let offered;
  const learner = new Learner(store, 'A', async (_system, input) => {
    offered = JSON.parse(input).existing;
    assert.equal(offered[0].id, saved.id);
    store.pin('A', saved.id, true);
    return { text: JSON.stringify({ memories: [{ action: 'merge', topic: 'style', kind: 'decision', text: 'Prefer terse responses.', targets: [{ id: saved.id, revision: saved.revision }], reason: 'Same policy.', evidence: [{ entry: 'u', quote: 'Prefer terse responses.' }] }] }), tokens: 1 };
  }, () => true, () => {});
  await learner.run(); await learner.close();
  assert.equal(store.get('A', saved.id).text, saved.text);
  assert.equal(store.get('A', saved.id).pinned, 1);
});

test('v4 migration backfills existing notes without importing jobs/history; reopen reuses vectors', async t => {
  const { store, path, embedding } = fixture(t);
  const saved = store.save('A', note('style'), { manual: true });
  store.enqueue('A', { session: 's', entries: [{ id: 'u', role: 'user', text: 'Not a document.' }] });
  store.db.exec('DROP TRIGGER vector_update; DROP TRIGGER vector_delete; DROP TRIGGER vector_insert; DROP TRIGGER vector_controls; DROP TABLE memory_vectors; DROP TABLE retrieval_state; PRAGMA user_version=4;');
  const migrated = new MemoryStore(path);
  const retrieval = new HybridRetrieval(migrated, embedding, 'A', () => true);
  await retrieval.backfill(); retrieval.close(); migrated.close();
  const reopened = new MemoryStore(path);
  try {
    assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(reopened.get('A', saved.id).manual, 1);
    assert.equal(reopened.db.prepare('SELECT model FROM memory_vectors').get().model, EMBEDDING_KEY);
    assert.equal(reopened.db.prepare('SELECT count(*) n FROM jobs WHERE payload IS NOT NULL').get().n, 1);
  } finally { reopened.close(); }
});

test('local worker has no queue, bounds hung inference, cancellation/shutdown, and no automatic restart/download', async t => {
  const { root } = fixture(t);
  const missing = new LocalEmbedding(root);
  assert.equal(await missing.embed(['query']), undefined);
  assert.match(missing.status, /setup/); assert.equal(missing.child, undefined); missing.close();
  for (const action of ['timeout', 'abort', 'close']) {
    const e = new LocalEmbedding(root); let killed = 0, sends = 0;
    e.ready = true; e.child = { send() { sends++; }, kill() { killed++; } };
    const controller = new AbortController();
    const waiting = e.embed(['query'], controller.signal, 20);
    assert.equal(await e.embed(['not queued']), undefined);
    if (action === 'abort') controller.abort();
    if (action === 'close') e.close();
    assert.equal(await waiting, undefined);
    assert.equal(killed, 1); assert.equal(sends, 1);
    assert.equal(await e.embed(['not restarted']), undefined); assert.equal(e.child, undefined);
    e.close();
  }
});

test('actual pinned local model runs off-thread, returns valid vectors and closes promptly', { skip: !process.env.PI_MEMORY_EMBEDDING_AGENT }, async t => {
  const e = new LocalEmbedding(process.env.PI_MEMORY_EMBEDDING_AGENT); t.after(() => e.close());
  const cold = performance.now();
  assert.equal(await e.embed(['terse responses']), undefined, 'cold call immediately uses FTS');
  for (let n = 0; n < 500 && !e.ready; n++) await delay(10);
  assert.equal(e.ready, true, e.status);
  const vectors = await e.embed(['terse responses', 'Keep explanations brief.'], undefined, 1000);
  assert.ok(vectors.every(validVector));
  const started = performance.now(); e.close(); assert.ok(performance.now() - started < 200);
  console.log(`local worker cold readiness ${Math.round(started - cold)}ms`);
});

test('retire/undo and global forget invalidate cached vectors and fence a pending backfill', async t => {
  const { store, retrieval, embedding } = fixture(t);
  const first = store.save('A', note('first', 'Keep explanations brief.'));
  const alias = store.save('A', note('alias', 'Avoid long introductions.'));
  const global = store.save(GLOBAL_SCOPE, note('global', 'Protect private client information.'), { manual: true });
  await retrieval.backfill();
  const text = 'Keep explanations brief and avoid long introductions.';
  const candidate = { ...note('first', text), sources: [{ session: 'new', entry: 'u', role: 'user', quote: text }], consolidation: { action: 'merge', targets: [first, alias].map(({ id, revision }) => ({ id, revision })), reason: 'One policy.' } };
  const changed = store.transaction(() => store.consolidateInside('A', candidate, Date.now() + 1, 0, [first, alias]));
  assert.ok(changed.changeId);
  assert.equal(store.get('A', alias.id).active, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_vectors').get().n, 1);
  let resolve; embedding.embed = () => new Promise(done => { resolve = done; });
  const waiting = retrieval.backfill();
  store.undo('A', changed.changeId);
  resolve([vector()]); await waiting;
  assert.equal(store.get('A', alias.id).manual, 1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_vectors').get().n, 1);
  embedding.embed = async texts => texts.map(() => vector()); await retrieval.backfill();
  embedding.embed = () => new Promise(done => { resolve = done; });
  const query = store.candidates('A', 'terse responses');
  store.forget(GLOBAL_SCOPE, global.id); resolve([vector()]);
  assert.deepEqual(await query, []);
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_vectors WHERE memory_id=?').get(global.id).n, 0);
});

test('retrieval revalidates SQLite after ranking when another process changes a revision', async t => {
  const { store, retrieval, path } = fixture(t);
  const saved = store.save('A', note('style')); await retrieval.backfill();
  const other = new MemoryStore(path), original = store.get.bind(store);
  store.get = (...args) => { other.save('A', note('style', 'Prefer detailed diagrams.')); return original(...args); };
  try { assert.deepEqual(await store.candidates('A', 'terse responses'), []); }
  finally { other.close(); }
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_vectors').get().n, 0);
  assert.equal(original('A', saved.id).revision, 2);
});

test('scan cap bounds semantic work while lexical recall remains available', async t => {
  const { store, retrieval, calls } = fixture(t);
  store.transaction(() => {
    for (let n = 0; n < 2001; n++) store.saveInside('A', note(`note-${n}`, `Synthetic explanatory detail number ${n}.`));
  });
  await retrieval.backfill();
  assert.equal(calls.length, 0); assert.match(retrieval.status, /2000/);
  const baseline = store.search('A', 'detail');
  assert.deepEqual((await store.candidates('A', 'detail')).map(n => n.id), baseline.map(n => n.id));
});

test('cancelling semantic candidate lookup before provider submission refunds the learning reservation', async t => {
  const { store, embedding } = fixture(t);
  store.save('A', note('style'));
  store.enqueue('A', { session: 's', entries: [{ id: 'u', role: 'user', text: 'Prefer terse responses.' }] });
  let entered = false, submitted = 0;
  embedding.embed = (_texts, signal) => new Promise(resolve => {
    entered = true; signal.addEventListener('abort', () => resolve(undefined), { once: true });
  });
  const learner = new Learner(store, 'A', async () => { submitted++; return { text: '{"memories":[]}', tokens: 0 }; }, () => true, () => {});
  learner.wake(0);
  for (let i = 0; i < 100 && !entered; i++) await delay(5);
  assert.ok(entered); await learner.close();
  assert.equal(submitted, 0); assert.equal(store.dailyBudget().used, 0);
  assert.equal(store.db.prepare('SELECT attempts FROM jobs').get().attempts, 0);
});

test('aborted consolidation inference recovers hybrid on a later idle pass without reload', { skip: !process.env.PI_MEMORY_EMBEDDING_AGENT }, async t => {
  const { store } = fixture(t);
  const e = new LocalEmbedding(process.env.PI_MEMORY_EMBEDDING_AGENT);
  const hybrid = new HybridRetrieval(store, e, 'A', () => true);
  store.retrieval = hybrid; t.after(() => hybrid.close());
  const saved = store.save('A', note('outage', 'When the service is unavailable, roll back to the last working release.'));
  e.start();
  const ready = async () => { for (let n = 0; n < 1000 && !e.ready; n++) await delay(10); assert.ok(e.ready, e.status); };
  await ready(); await hybrid.backfill();
  const prompt = 'Restore the previous deployment if production goes down.';
  const controller = new AbortController();
  const lookup = store.candidates('A', prompt, 12, { purpose: 'learning', signal: controller.signal });
  controller.abort('foreground');
  assert.deepEqual(await lookup, []);
  assert.match(e.status, /idle restart pending/); assert.equal(e.child, undefined);
  assert.deepEqual(await store.candidates('A', prompt), [], 'foreground stays on FTS and does not restart');
  assert.equal(e.child, undefined);
  await hybrid.backfill(); // The ordinary bounded idle pass permits one new cold start.
  await ready();
  assert.equal((await store.candidates('A', prompt))[0].id, saved.id);
  assert.equal(e.status, 'hybrid');
});

test('late send errors from a cancelled worker cannot disable its idle replacement', async t => {
  const { root } = fixture(t);
  const e = new LocalEmbedding(root); let sent;
  e.ready = true;
  e.child = { send(_message, callback) { sent = callback; }, kill() {} };
  const controller = new AbortController();
  const lookup = e.embed(['query'], controller.signal);
  controller.abort(); await lookup;
  const replacement = { kill() {} };
  e.child = replacement; e.ready = true; e.cancelled = false; e.status = 'hybrid';
  sent(new Error('Old IPC channel closed'));
  assert.equal(e.child, replacement); assert.equal(e.ready, true); assert.equal(e.status, 'hybrid');
  e.close();
});
