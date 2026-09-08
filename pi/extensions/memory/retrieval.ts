import { GLOBAL_SCOPE, redact, searchTerms } from './policy.ts';
import { MODEL, EMBEDDING_KEY, embeddingText, sha256, validVector } from './embedding-config.mjs';
import type { MemoryStore, RetrievalOptions } from './store.ts';
import type { LocalEmbedding } from './embedding.ts';

const MAX_VECTORS = 2000;
const MIN_SIMILARITY = 0.40;

/** RRF combines ranks, never incomparable BM25 and cosine scores. */
export function reciprocalRankFusion(lexical: string[], semantic: string[]) {
  const scores = new Map<string, number>();
  for (const list of [lexical, semantic]) for (const [rank, id] of [...new Set(list)].entries()) scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank + 1));
  return [...scores.keys()].sort((a, b) => scores.get(b)! - scores.get(a)! || (lexical.indexOf(a) < 0 ? Infinity : lexical.indexOf(a)) - (lexical.indexOf(b) < 0 ? Infinity : lexical.indexOf(b)) || a.localeCompare(b));
}

export class HybridRetrieval {
  store: MemoryStore;
  embedding: LocalEmbedding;
  scope: string;
  allowed: () => boolean;
  idle: () => boolean;
  timer?: ReturnType<typeof setTimeout>;
  closed = false;
  running = false;
  state = 'FTS: backfill pending';

  constructor(store: MemoryStore, embedding: LocalEmbedding, scope: string, allowed: () => boolean, idle = allowed) {
    this.store = store; this.embedding = embedding; this.scope = scope; this.allowed = allowed; this.idle = idle;
  }
  get status() { return this.embedding.ready ? this.state : this.embedding.status; }
  live() { return !this.closed && !this.store.closed && this.allowed(); }
  overLimit(scope: string, includeGlobal: boolean) {
    const count = this.store.db.prepare('SELECT count(*) n FROM (SELECT id FROM memories WHERE active=1 AND scope IN (?,?) LIMIT ?)')
      .get(scope, includeGlobal ? GLOBAL_SCOPE : scope, MAX_VECTORS + 1)!;
    return Number(count.n) > MAX_VECTORS;
  }

  wake() {
    if (!this.live() || this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = undefined;
      if (!this.live()) return;
      try { if (this.idle()) await this.backfill(); } catch { this.state = 'FTS: vector index error'; }
      this.wake();
    }, 1000);
    this.timer.unref();
  }

  async backfill() {
    if (!this.live() || this.running) return;
    const epoch = this.store.retrievalEpoch();
    const control = this.store.control(this.scope);
    if (!control.reading && !control.learning) return;
    if (this.overLimit(this.scope, !!control.reading)) { this.state = 'FTS: vector scan cap (2000)'; return; }
    this.embedding.start();
    if (!this.embedding.ready) return;
    this.running = true;
    try {
      const notes: any[] = this.store.db.prepare(`SELECT m.id,m.scope,m.revision,m.topic,m.text,m.keywords FROM memories m
        LEFT JOIN memory_vectors v ON v.memory_id=m.id AND v.model=? AND v.revision=m.revision
        WHERE m.active=1 AND (m.scope=? OR (m.scope=? AND m.manual=1)) AND v.memory_id IS NULL ORDER BY m.id LIMIT 16`)
        .all(EMBEDDING_KEY, this.scope, control.reading ? GLOBAL_SCOPE : this.scope);
      if (!notes.length) { this.state = 'hybrid'; return; }
      this.state = 'hybrid: backfilling';
      const vectors = await this.embedding.embed(notes.map(embeddingText), undefined, 5000);
      if (!vectors || vectors.length !== notes.length || !vectors.every(validVector) || !this.live() || !this.idle()) return;
      // No async transaction: compare the epoch under the write lock. Forget,
      // retire, undo, edits and control toggles in any process fence late results.
      this.store.transaction(() => {
        if (this.store.retrievalEpoch() !== epoch) return;
        const insert = this.store.db.prepare(`INSERT INTO memory_vectors(memory_id,model,revision,digest,vector)
          SELECT id,?,revision,?,? FROM memories WHERE id=? AND scope=? AND revision=? AND active=1
          ON CONFLICT(memory_id) DO UPDATE SET model=excluded.model,revision=excluded.revision,digest=excluded.digest,vector=excluded.vector`);
        notes.forEach((note, i) => insert.run(EMBEDDING_KEY, sha256(embeddingText(note)), Buffer.from(new Float32Array(vectors[i]).buffer), note.id, note.scope, note.revision));
      });
    } finally { this.running = false; }
  }

  async search(scope: string, query: string, limit: number, { purpose = 'reading', signal, allowed = () => true }: RetrievalOptions = {}) {
    const permitted = () => this.live() && allowed() && !signal?.aborted && (scope === this.scope || scope === GLOBAL_SCOPE) && !!this.store.control(this.scope)[purpose === 'learning' ? 'learning' : 'reading'];
    if (!permitted()) return [];
    const lexical = () => this.store.search(scope, query, 30, purpose !== 'learning');
    query = redact(query);
    if (!searchTerms(query).length) return [];
    const epoch = this.store.retrievalEpoch();
    const fallback = () => {
      if (!permitted() || epoch !== this.store.retrievalEpoch()) return [];
      const result = lexical().slice(0, limit);
      return permitted() && epoch === this.store.retrievalEpoch() ? result : [];
    };
    try {
      if (this.overLimit(scope, purpose !== 'learning')) { this.state = 'FTS: vector scan cap (2000)'; return fallback(); }
      const vectors = await this.embedding.embed([query.slice(0, 1000)], signal);
      if (!permitted()) return [];
      if (!vectors || !validVector(vectors[0])) return fallback();
      if (epoch !== this.store.retrievalEpoch()) return [];
      const rows: any[] = this.store.db.prepare(`SELECT m.id,m.revision,m.topic,m.text,m.keywords,v.vector,v.digest FROM memories m
        JOIN memory_vectors v ON v.memory_id=m.id AND v.model=? AND v.revision=m.revision
        WHERE m.active=1 AND (m.scope=? OR (m.scope=? AND m.manual=1)) ORDER BY m.id LIMIT ?`)
        .all(EMBEDDING_KEY, scope, purpose === 'learning' ? scope : GLOBAL_SCOPE, MAX_VECTORS + 1);
      if (rows.length > MAX_VECTORS) { this.state = 'FTS: vector scan cap (2000)'; return fallback(); }
      const semantic = rows.flatMap(row => {
        if (row.digest !== sha256(embeddingText(row)) || row.vector.byteLength !== MODEL.dimensions * 4) return [];
        const vector = Array.from(new Float32Array(Uint8Array.from(row.vector).buffer));
        if (!validVector(vector)) return [];
        const score = vector.reduce((n, x, i) => n + x * vectors[0][i], 0);
        return score >= MIN_SIMILARITY ? [{ id: row.id, score }] : [];
      }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 30);
      const fullText = lexical();
      const revisions = new Map([...rows, ...fullText].map(row => [row.id, row.revision]));
      const ids = reciprocalRankFusion(fullText.map(row => row.id), semantic.map(row => row.id));
      // SQLite is authoritative; neither cached vectors nor IPC carry recall text.
      const result = ids.flatMap(id => {
        try { const row = this.store.get(scope, id); return row.active && row.revision === revisions.get(id) && (purpose !== 'learning' || row.scope === scope) ? [row] : []; }
        catch { return []; }
      }).slice(0, Math.min(30, Math.max(1, limit)));
      return permitted() && epoch === this.store.retrievalEpoch() ? result : [];
    } catch { this.state = 'FTS: vector index error'; return fallback(); }
  }

  close() { this.closed = true; clearTimeout(this.timer); this.embedding.close(); }
}
