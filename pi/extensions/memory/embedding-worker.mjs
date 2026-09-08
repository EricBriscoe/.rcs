// Dedicated, killable inference process: no database, credentials or query files.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { EMBEDDING_KEY, validVector } from './embedding-config.mjs';

// Local model loading only; even accidental library fetches must fail closed.
globalThis.fetch = async () => { throw Error('Embedding network access disabled.'); };
process.on('disconnect', () => process.exit());
try {
  const home = process.argv[2];
  if (await readFile(join(home, 'ready'), 'utf8') !== EMBEDDING_KEY) throw Error('Model not installed.');
  const require = createRequire(join(home, 'package.json'));
  const { pipeline, env } = await import(pathToFileURL(require.resolve('@huggingface/transformers')).href);
  env.allowRemoteModels = false;
  env.useFSCache = false;
  const model = await pipeline('feature-extraction', join(home, 'model'), {
    device: 'cpu', dtype: 'q8', local_files_only: true,
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
  });
  let busy = false;
  process.on('message', async message => {
    try {
      if (busy || !Array.isArray(message.texts) || !message.texts.length || message.texts.length > 16 || message.texts.some(t => typeof t !== 'string' || t.length > 2400)) throw Error('Invalid request.');
      busy = true;
      const vectors = (await model(message.texts, { pooling: 'mean', normalize: true, truncation: true, max_length: 256 })).tolist();
      if (!vectors.every(validVector)) throw Error('Invalid vectors.');
      process.send?.({ vectors });
    } catch { process.send?.({ error: true }); }
    finally { busy = false; }
  });
  process.send?.({ ready: true });
} catch { process.send?.({ error: true }); process.exitCode = 1; process.disconnect?.(); }
