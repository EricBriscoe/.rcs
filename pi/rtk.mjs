#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:os';
import { agentDirectory, effectiveRtk } from './extensions/efficiency/runtime.mjs';

const checkout = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const agent = agentDirectory(), { version } = effectiveRtk(checkout, agent);
const child = spawn(join(agent, 'tooling/rtk', version, 'rtk'), process.argv.slice(2), {
  stdio: 'inherit', env: { ...process.env, RTK_TELEMETRY_DISABLED: '1' },
});
child.on('error', () => { console.error('RTK unavailable. Run setup-pi.sh or launch Pi to update dependencies.'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1); });
process.on('SIGINT', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));
