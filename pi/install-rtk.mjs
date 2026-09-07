import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, chmod, lstat, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function installRtk(agentDir, pins, { platform = `${process.platform}-${process.arch}`, download = fetch } = {}) {
  const asset = pins.assets[platform];
  if (!asset || !/^\d+\.\d+\.\d+$/.test(pins.version) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^rtk-[\w-]+\.tar\.gz$/.test(asset.name)) throw Error('Unsupported RTK platform or invalid pin.');
  const parent = join(agentDir, 'tooling', 'rtk'), dest = join(parent, pins.version);
  for (const dir of [join(agentDir, 'tooling'), parent]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await lstat(dir)).isSymbolicLink()) throw Error('RTK tooling must not be a symlink.');
    await chmod(dir, 0o700);
  }
  const valid = async () => {
    try {
      if (!(await lstat(dest)).isDirectory() || (await lstat(dest)).isSymbolicLink()) return false;
      const metadata = JSON.parse(await readFile(join(dest, 'installed.json'), 'utf8'));
      const binary = join(dest, 'rtk'), info = await lstat(binary);
      return info.isFile() && !info.isSymbolicLink() && (info.mode & 0o111) !== 0 && metadata.archive === asset.sha256 && metadata.binary === hash(await readFile(binary));
    } catch { return false; }
  };
  if (await valid()) return join(dest, 'rtk');
  // Never execute install scripts or rtk init; never replace an unknown directory.
  try { await lstat(dest); throw Error(`Invalid RTK installation at ${dest}; inspect/remove it and retry.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = await mkdtemp(join(parent, '.install-'));
  try {
    const response = await download(`https://github.com/rtk-ai/rtk/releases/download/v${pins.version}/${asset.name}`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error(`RTK download failed: HTTP ${response.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 50 * 1024 * 1024) throw Error('RTK download exceeds 50 MB.');
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (hash(bytes) !== asset.sha256) throw Error('RTK archive checksum mismatch. Nothing installed.');
    const archive = join(temp, 'download.tar.gz'); await writeFile(archive, bytes, { mode: 0o600 });
    const unpack = join(temp, 'unpack'); await mkdir(unpack, { mode: 0o700 });
    await exec('tar', ['-xzf', archive, '-C', unpack, 'rtk'], { timeout: 15000 });
    const binary = join(unpack, 'rtk'), info = await lstat(binary);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('RTK archive did not contain a regular binary.');
    await chmod(binary, 0o700);
    await writeFile(join(unpack, 'installed.json'), JSON.stringify({ archive: asset.sha256, binary: hash(await readFile(binary)) }), { mode: 0o600 });
    try { await rename(unpack, dest); }
    catch (error) { if (!await valid()) throw error; } // Another installer finished first.
    return join(dest, 'rtk');
  } finally { await rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pins = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'rtk.json'), 'utf8'));
  console.log(`RTK installed: ${await installRtk(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), pins)}`);
}
