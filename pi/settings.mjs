import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { agentDirectory } from './extensions/efficiency/runtime.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined;
function read(path) {
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!object(value)) throw Error(`Expected a settings object: ${path}`);
  return value;
}
// Missing keys are meaningful: a local deletion overrides an old default too.
export function mergeSettings(previous, local, defaults) {
  if (isDeepStrictEqual(previous, local)) return defaults;
  if (!object(local) || !object(defaults) || (previous !== undefined && !object(previous))) return local;
  const result = Object.create(null);
  for (const key of new Set([...Object.keys(previous ?? {}), ...Object.keys(local), ...Object.keys(defaults)])) {
    const value = mergeSettings(own(previous, key), own(local, key), own(defaults, key));
    if (value !== undefined) result[key] = value;
  }
  return result;
}
function atomicWrite(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

export function syncSettings(checkout, agent = agentDirectory()) {
  const defaults = read(join(checkout, 'pi/settings.json'));
  if (!defaults) throw Error('Shared Pi defaults are missing.');
  // Runtime changelog state must never be inherited from shared defaults.
  delete defaults.lastChangelogVersion;
  mkdirSync(agent, { recursive: true });
  const path = join(agent, 'settings.json');
  const baselinePath = join(agent, 'settings-defaults.json');
  if (existsSync(baselinePath) && lstatSync(baselinePath).isSymbolicLink()) throw Error('Settings baseline must not be a symlink.');
  const local = read(path);
  const previous = read(baselinePath);
  const merged = local === undefined ? defaults : mergeSettings(previous, local, defaults);
  const symlink = existsSync(path) && lstatSync(path).isSymbolicLink();
  // Retain the original file/link for first-time migration, without writing its target.
  if (local !== undefined && (previous === undefined || symlink)) {
    const backup = join(agent, `settings-backup.${randomUUID()}`);
    mkdirSync(backup, { mode: 0o700 });
    renameSync(path, join(backup, 'settings.json'));
  }
  if (!existsSync(path) || !isDeepStrictEqual(JSON.parse(JSON.stringify(merged)), local)) atomicWrite(path, merged);
  if (!isDeepStrictEqual(previous, defaults)) atomicWrite(baselinePath, defaults);
  return merged;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  syncSettings(dirname(dirname(fileURLToPath(import.meta.url))));
}
