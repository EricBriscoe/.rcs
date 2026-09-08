import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { MODEL, EMBEDDING_KEY, embeddingHome, sha256 } from './extensions/memory/embedding-config.mjs';

const exec = promisify(execFile);
export async function installMemoryEmbedding(agent, download = fetch) {
  const dest = embeddingHome(agent), parent = join(dest, '..');
  for (const dir of [join(agent, 'tooling'), parent]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await lstat(dir)).isSymbolicLink()) throw Error('Embedding tooling must not be a symlink.');
    await chmod(dir, 0o700);
  }
  const valid = async () => {
    try {
      if (!(await lstat(dest)).isDirectory() || (await lstat(dest)).isSymbolicLink()) return false;
      if ((await readFile(join(dest, 'ready'), 'utf8')) !== EMBEDDING_KEY) return false;
      if (!(await lstat(join(dest, 'node_modules/@huggingface/transformers/dist/transformers.node.cjs'))).isFile()) return false;
      if (sha256(await readFile(join(dest, 'package-lock.json'))) !== sha256(await readFile(new URL('./extensions/memory/embedding-runtime/package-lock.json', import.meta.url)))) return false;
      for (const [file, pin] of Object.entries(MODEL.files)) {
        const bytes = await readFile(join(dest, 'model', file));
        if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) return false;
      }
      return true;
    } catch { return false; }
  };
  if (await valid()) return dest;
  try { await lstat(dest); throw Error(`Invalid embedding installation: inspect ${dest} before retrying.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = await mkdtemp(join(parent, '.install-'));
  try {
    for (const file of ['package.json', 'package-lock.json']) await copyFile(new URL(`./extensions/memory/embedding-runtime/${file}`, import.meta.url), join(temp, file));
    await exec('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], { cwd: temp, timeout: 180000 });
    for (const [file, pin] of Object.entries(MODEL.files)) {
      const response = await download(`https://huggingface.co/${MODEL.model}/resolve/${MODEL.revision}/${file}`, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw Error(`Embedding model download: HTTP ${response.status}`);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > pin.bytes) throw Error('Embedding model exceeds pinned size.');
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      if (size !== pin.bytes || sha256(bytes) !== pin.sha256) throw Error('Embedding model checksum mismatch.');
      const target = join(temp, 'model', file);
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o600 });
    }
    await writeFile(join(temp, 'ready'), EMBEDDING_KEY, { mode: 0o600 });
    try { await rename(temp, dest); }
    catch (error) { if (!await valid()) throw error; }
    return dest;
  } finally { await rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`Local memory embeddings installed: ${await installMemoryEmbedding(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'))}. Run /reload.`);
}
