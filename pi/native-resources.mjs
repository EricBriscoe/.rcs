import { join, delimiter } from "node:path";
import { homedir } from "node:os";

import { effectiveRtk } from "./extensions/efficiency/runtime.mjs";

// Pi owns resource discovery; RTK follows machine-local updates, then bootstrap pins.
export function nativeEnvironment(checkout, env = process.env) {
  try {
    const { version } = effectiveRtk(checkout, env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"));
    if (!/^\d+\.\d+\.\d+$/.test(version)) return env;
    const bin = join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "tooling/rtk", version);
    return { ...env, PATH: `${bin}${delimiter}${env.PATH || ""}`, RTK_TELEMETRY_DISABLED: "1", RTK_NO_TOML: "1" };
  } catch { return env; }
}
