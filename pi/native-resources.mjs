import { readFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";

// The wrapper supplies RTK's pinned binary; Pi owns normal resource discovery.
export function nativeEnvironment(checkout, env = process.env) {
  try {
    const { version } = JSON.parse(readFileSync(join(checkout, "pi/rtk.json"), "utf8"));
    if (!/^\d+\.\d+\.\d+$/.test(version)) return env;
    const bin = join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "tooling/rtk", version);
    return { ...env, PATH: `${bin}${delimiter}${env.PATH || ""}`, RTK_TELEMETRY_DISABLED: "1", RTK_NO_TOML: "1" };
  } catch { return env; }
}
