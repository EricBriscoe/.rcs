#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:os";
import { nativeEnvironment } from "./native-resources.mjs";
import { syncSettings } from "./settings.mjs";
import { agentDirectory, autoUpdateEnabled, packageInstallEnvironment } from "./extensions/efficiency/runtime.mjs";

// Setup owns this machine-local runtime pin; project Node selections stay untouched.
let runtime;
try { runtime = readFileSync(join(agentDirectory(), "runtime-node"), "utf8").trim(); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (runtime && runtime !== process.execPath) {
  const child = spawn(runtime, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("error", () => { console.error("Pi's configured Node runtime is unavailable. Rerun setup-pi.sh."); process.exitCode = 1; });
  await new Promise(resolve => child.on("close", (code, signal) => {
    process.exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1);
    resolve();
  }));
  process.exit(process.exitCode);
}

const checkout = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
// Detach legacy settings links even when updates are disabled.
syncSettings(checkout);
if (autoUpdateEnabled(process.argv.slice(2))) {
  try { const { updateDependencies } = await import("./update-deps.mjs"); await updateDependencies(checkout); }
  catch { console.error("Pi dependency update failed. Continuing with installed versions; PI_AUTO_UPDATE=0 bypasses updates."); }
}
syncSettings(checkout);
const installEnv = { ...process.env, PATH: runtime ? `${dirname(runtime)}:${process.env.PATH || ""}` : process.env.PATH };
const packageRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", cwd: agentDirectory(), env: installEnv }).trim();
const cli = join(packageRoot, "@earendil-works/pi-coding-agent/dist/cli.js");
// Only this explicit package operation may run native dependency install scripts.
const knowledgeInstall = ["install", "update"].includes(process.argv[2]) && process.argv[3] === "npm:pi-knowledge" && process.argv.length === 4;
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit", env: { ...nativeEnvironment(checkout), ...(["install", "update", "remove"].includes(process.argv[2]) ? { PATH: installEnv.PATH } : {}), PI_AUTO_UPDATE_ACTIVE: "1", ...packageInstallEnvironment(knowledgeInstall ? "npm:pi-knowledge" : undefined), npm_config_audit: "false", npm_config_fund: "false" } });
child.on("error", () => { console.error("Cannot start Pi. Run setup-pi.sh, or use PI_AUTO_UPDATE=0 while repairing the installation."); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1); });
// Both processes share the terminal process group; the native Pi process owns
// interactive Ctrl+C handling. Keep this launcher alive until it exits.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));
