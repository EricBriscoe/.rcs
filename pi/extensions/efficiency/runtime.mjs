import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const agentDirectory = (env = process.env) => env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
export const stableVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
export function runtimeDependencies(agent = agentDirectory()) {
  try { return JSON.parse(readFileSync(join(agent, 'updates/current.json'), 'utf8')); }
  catch { return {}; }
}
export function effectiveRtk(checkout, agent = agentDirectory()) {
  const runtime = runtimeDependencies(agent);
  const rtk = JSON.parse(readFileSync(join(checkout, 'pi/rtk.json'), 'utf8'));
  return stableVersion(runtime.rtk?.version) ? { ...rtk, ...runtime.rtk } : rtk;
}
// Only explicit stock pi-knowledge operations need native dependency scripts.
export function packageInstallEnvironment(source) {
  return { npm_config_ignore_scripts: source === 'npm:pi-knowledge' ? 'false' : 'true' };
}
export function autoUpdateEnabled(args = [], env = process.env) {
  return env.PI_AUTO_UPDATE !== '0' && env.PI_OFFLINE !== '1' && env.PI_AUTO_UPDATE_ACTIVE !== '1' && env.PI_SUBAGENT_CHILD !== '1' && !args.includes('--offline');
}
