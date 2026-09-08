import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const MODEL = JSON.parse(readFileSync(new URL('./embedding-model.json', import.meta.url), 'utf8'));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Dependency lock, model revision and preprocessing all participate in invalidation.
export const EMBEDDING_KEY = sha256(readFileSync(new URL('./embedding-runtime/package-lock.json', import.meta.url))) + ':' + MODEL.revision + ':q8:mean:l2:256:v1';
export const embeddingHome = agent => join(agent, 'tooling', 'memory-embedding', sha256(EMBEDDING_KEY).slice(0, 20));
export function validVector(value) {
  if (!Array.isArray(value) || value.length !== MODEL.dimensions || !value.every(Number.isFinite)) return false;
  const norm = value.reduce((n, x) => n + x * x, 0);
  return Math.abs(norm - 1) < 0.01;
}
export const embeddingText = note => `${note.topic}\n${note.text}\n${note.keywords}`;
