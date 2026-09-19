#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:os";
import { nativeEnvironment } from "./native-resources.mjs";
import { autoUpdateEnabled, packageInstallEnvironment } from "./extensions/efficiency/runtime.mjs";

const checkout = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
if (autoUpdateEnabled(process.argv.slice(2))) {
  try { const { updateDependencies } = await import("./update-deps.mjs"); await updateDependencies(checkout); }
  catch { console.error("Pi dependency update failed. Continuing with installed versions; PI_AUTO_UPDATE=0 bypasses updates."); }
}
const packageRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const cli = join(packageRoot, "@earendil-works/pi-coding-agent/dist/cli.js");
// Only this explicit package operation may run native dependency install scripts.
const knowledgeInstall = ["install", "update"].includes(process.argv[2]) && process.argv[3] === "npm:pi-knowledge" && process.argv.length === 4;
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit", env: { ...nativeEnvironment(checkout), PI_AUTO_UPDATE_ACTIVE: "1", ...packageInstallEnvironment(knowledgeInstall ? "npm:pi-knowledge" : undefined), npm_config_audit: "false", npm_config_fund: "false" } });
child.on("error", () => { console.error("Cannot start Pi. Run setup-pi.sh, or use PI_AUTO_UPDATE=0 while repairing the installation."); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1); });
// Both processes share the terminal process group; the native Pi process owns
// interactive Ctrl+C handling. Keep this launcher alive until it exits.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));
