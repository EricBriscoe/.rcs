#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:os";
import { nativeEnvironment } from "./native-resources.mjs";

const checkout = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const packageRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const cli = join(packageRoot, "@earendil-works/pi-coding-agent/dist/cli.js");
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit", env: nativeEnvironment(checkout) });
child.on("error", () => { console.error("Cannot start Pi. Run setup-pi.sh to install the pinned version."); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1); });
// Both processes share the terminal process group; the native Pi process owns
// interactive Ctrl+C handling. Keep this launcher alive until it exits.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));
