import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { MemoryStore } from '../pi/extensions/memory/store.ts';
import { LocalEmbedding } from '../pi/extensions/memory/embedding.ts';
import { HybridRetrieval } from '../pi/extensions/memory/retrieval.ts';

// Fixed synthetic relevance judgments: no provider extraction, real notes or credentials.
const notes = [
  ['style', 'Keep explanations brief; omit lengthy introductions.'],
  ['delivery', 'Require explicit approval before publishing changes to the remote repository.'],
  ['outage', 'When the service is unavailable, roll back to the last working release.'],
  ['privacy', 'Never send confidential customer information to third-party services.'],
  ['transaction', 'Wrap related database writes in one atomic transaction.'],
  ['retry', 'Use exponential backoff with random jitter after transient throttling.'],
  ['package', 'Install project dependencies with pnpm, not npm.'],
  ['encoding', 'Measure payload size in UTF-8 bytes rather than JavaScript string length.'],
  ['cache', 'Clear account-specific cached server state when changing subscriptions.'],
  ['diagnostic', 'Set QZ_E731_CACHE to inspect the cache diagnostic trace.'],
  ['reload', 'The reloadFenceV2 helper prevents stale worker results from being committed.'],
  ['path', 'The migration journal lives at /var/synthetic/zeta-migrations.sqlite.'],
  ['negative-policy', 'Do not delete archived audit records; preserve them for investigation.'],
];
const queries = [
  ['paraphrase', 'I prefer terse answers without a preamble.', 'style'],
  ['paraphrase', 'Ask permission before you push commits upstream.', 'delivery'],
  ['paraphrase', 'Restore the previous deployment if production goes down.', 'outage'],
  ['paraphrase', 'Keep private client data away from external vendors.', 'privacy'],
  ['paraphrase', 'All SQL mutations must either succeed together or leave nothing changed.', 'transaction'],
  ['paraphrase', 'Space out repeated attempts with increasing randomized delays.', 'retry'],
  ['lexical', 'pnpm dependencies', 'package'],
  ['lexical', 'UTF-8 payload bytes', 'encoding'],
  ['lexical', 'account subscriptions cached state', 'cache'],
  ['identifier', 'QZ_E731_CACHE', 'diagnostic'],
  ['identifier', 'reloadFenceV2', 'reload'],
  ['identifier', '/var/synthetic/zeta-migrations.sqlite', 'path'],
  ['negation', 'May we erase historical audit logs?', 'negative-policy'],
  ['negative', 'Growing purple orchids on an asteroid', null],
  ['negative', 'Medieval Byzantine pottery glazes', null],
  ['negative', 'Underwater volcanoes and tectonic magma', null],
  ['negative', 'A recipe for pistachio ice cream', null],
  ['negative', 'Penguin courtship in Antarctica', null],
  ['negative', 'Quantum entanglement in photon experiments', null],
];
const distractors = [
  'The application uses blue navigation icons.', 'Monthly reports display currency in euros.',
  'The test fixture clock starts at noon.', 'Image thumbnails have a square aspect ratio.',
  'The warehouse dashboard groups products by category.', 'Invoice numbers use a yearly sequence.',
  'The demo maps use the Mercator projection.', 'The mobile menu opens from the left edge.',
  'The sample chart draws a dotted trend line.', 'The onboarding wizard has three pages.',
  'The dashboard header displays the organization logo.', 'Search results display item titles in bold.',
  'The sample calendar starts weeks on Monday.', 'The demo table sorts names alphabetically.',
  'The synthetic address form accepts apartment numbers.', 'The fixture color palette contains eight colors.',
  'The public landing page has a newsletter form.', 'The measurement chart labels distances in kilometers.',
  'The demonstration inventory includes metal bolts.', 'The demo shopping basket shows subtotal and tax.',
];

test('synthetic actual-model evaluation: FTS versus hybrid, paraphrases/identifiers/negatives/distractors', { skip: !process.env.PI_MEMORY_EMBEDDING_AGENT }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-hybrid-eval-')), path = join(root, 'memory.sqlite');
  const store = new MemoryStore(path), embedding = new LocalEmbedding(process.env.PI_MEMORY_EMBEDDING_AGENT);
  const retrieval = new HybridRetrieval(store, embedding, 'synthetic', () => true); store.retrieval = retrieval;
  t.after(() => { retrieval.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  for (const [topic, text] of [...notes, ...distractors.map((text, i) => [`distractor-${i}`, text])]) store.save('synthetic', { topic, text, keywords: '', kind: 'decision', sources: [] });
  const coldStart = performance.now();
  const coldResult = await store.candidates('synthetic', queries[0][1]);
  const coldFallbackMs = performance.now() - coldStart;
  assert.deepEqual(coldResult, store.search('synthetic', queries[0][1]));
  for (let n = 0; n < 1000 && !embedding.ready; n++) await delay(10);
  assert.ok(embedding.ready, embedding.status);
  const coldReadyMs = performance.now() - coldStart;
  const firstQueryStart = performance.now();
  assert.ok(await embedding.embed([queries[0][1]], undefined, 1000));
  const firstQueryMs = performance.now() - firstQueryStart;
  const backfillStart = performance.now();
  for (let n = 0; n < 4; n++) await retrieval.backfill();
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_vectors').get().n, notes.length + distractors.length);
  const backfillMs = performance.now() - backfillStart;
  const results = [], warm = [];
  for (const [category, query, expected] of queries) {
    const ftsStart = performance.now(); const fts = store.search('synthetic', query).map(n => n.topic); const ftsMs = performance.now() - ftsStart;
    const start = performance.now(); const hybrid = (await store.candidates('synthetic', query)).map(n => n.topic); const ms = performance.now() - start;
    warm.push(ms); results.push({ category, expected, fts, hybrid, ftsMs, hybridMs: ms });
  }
  const positive = results.filter(r => r.expected), negative = results.filter(r => !r.expected);
  const metrics = mode => ({
    recallAt8: positive.filter(r => r[mode].includes(r.expected)).length / positive.length,
    mrr: positive.reduce((n, r) => n + (r[mode].includes(r.expected) ? 1 / (r[mode].indexOf(r.expected) + 1) : 0), 0) / positive.length,
    precisionAtReturned: positive.reduce((n, r) => n + Number(r[mode].includes(r.expected)), 0) / positive.reduce((n, r) => n + r[mode].length, 0),
    negativeFalseHits: negative.filter(r => r[mode].length).length,
  });
  warm.sort((a, b) => a - b);
  const report = { corpus: notes.length + distractors.length, queries: results.length, coldFallbackMs, coldReadyMs, firstQueryMs, backfillMs, warmMedianMs: warm[Math.floor(warm.length / 2)], warmP95Ms: warm[Math.ceil(warm.length * .95) - 1], sqliteBytes: statSync(path).size + statSync(path + '-wal').size, vectorBytes: (notes.length + distractors.length) * 384 * 4, fts: metrics('fts'), hybrid: metrics('hybrid'), results };
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.hybrid.recallAt8 >= report.fts.recallAt8);
  assert.ok(results.some(r => r.category === 'paraphrase' && !r.fts.includes(r.expected) && r.hybrid.includes(r.expected)), 'actual semantic improvement, not merely a mocked embedding');
  assert.ok(results.filter(r => r.category === 'identifier').every(r => r.hybrid[0] === r.expected));
  assert.equal(report.hybrid.negativeFalseHits, 0);
  assert.ok(coldFallbackMs < 150); assert.ok(report.warmP95Ms < 200);
});
