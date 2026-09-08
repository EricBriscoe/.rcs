import { access, readFile, writeFile, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { join, delimiter, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { digest, exec, privateDir, NavState } from "./state.ts";

export async function executable(name: string): Promise<string> {
  for (const path of isAbsolute(name) ? [name] : (process.env.PATH || "").split(delimiter).map(dir => join(dir, name))) {
    try { await access(path, constants.X_OK); return await realpath(path); } catch {}
  }
  throw new Error(`${name} is not installed/on PATH. Install an official pinned server in user-local tooling, then configure it; do not modify project dependencies without permission.`);
}

export async function installPackages(stateDir: string, packages: string[], signal?: AbortSignal) {
  if (!packages.length || packages.some(pkg => !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(pkg))) throw new Error("Packages must use exact versions, not tags, ranges, URLs or scripts.");
  const parent = join(stateDir, "packages"); privateDir(parent);
  const dir = join(parent, digest(JSON.stringify([...packages].sort())).slice(0, 24));
  privateDir(dir);
  const ready = join(dir, "ready.json");
  const until = Date.now() + 180000;
  const state = new NavState(stateDir);
  const owner = randomUUID();
  try {
    while (true) {
      signal?.throwIfAborted();
      try { await access(ready); return dir; } catch {}
      if (state.claimInstall(dir, owner)) break;
      if (Date.now() > until) throw new Error("Another installer holds the tooling lock. Retry after it finishes.");
      await delay(100, undefined, { signal });
    }
    // A concurrent installer may have finished between the marker check and claim.
    try { await access(ready); return dir; } catch {}
    signal?.throwIfAborted();
    const dependencies = Object.fromEntries(packages.map(pkg => { const at = pkg.lastIndexOf("@"); return [pkg.slice(0, at), pkg.slice(at + 1)]; }));
    await writeFile(join(dir, "package.json"), JSON.stringify({ private: true, dependencies }), { mode: 0o600 });
    try {
      await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org"], { cwd: dir, timeout: 150000, maxBuffer: 1024 * 1024, signal });
    } catch (error: any) {
      signal?.throwIfAborted();
      throw new Error(`Pinned tooling installation failed (${error.code || "unknown"}); retry setup. No project files were modified.`);
    }
    signal?.throwIfAborted();
    await writeFile(ready, JSON.stringify(packages), { mode: 0o600 });
    return dir;
  } finally { state.releaseInstall(dir, owner); state.close(); }
}

export async function recipeCommand(stateDir: string, recipe: any, signal?: AbortSignal) {
  if (recipe.command) return [await executable(recipe.command[0]), ...recipe.command.slice(1)];
  const dir = await installPackages(stateDir, recipe.packages, signal);
  // TypeScript 7 ships native LSP and no longer provides tsserver.js for the
  // legacy adapter. Keep older bootstrap recipes working without pinning back.
  const typescript = recipe.packages.find((spec: string) => spec.startsWith("typescript@"));
  if (recipe.package === "typescript-language-server" && Number(typescript?.split("@").at(-1)?.split(".")[0]) >= 7) {
    const tsDir = join(dir, "node_modules", "typescript");
    const manifest = JSON.parse(await readFile(join(tsDir, "package.json"), "utf8"));
    if (typeof manifest.bin?.tsc !== "string") throw new Error("TypeScript no longer exposes the expected native LSP launcher.");
    return [process.execPath, join(tsDir, manifest.bin.tsc), "--lsp", "--stdio"];
  }
  const pkgDir = join(dir, "node_modules", recipe.package);
  const manifest = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8"));
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[recipe.bin];
  if (!entry) throw new Error("Pinned server package does not expose the expected executable.");
  return [process.execPath, join(pkgDir, entry), ...(recipe.args || [])];
}

export async function astCommand(stateDir: string, version: string, signal?: AbortSignal) {
  const platform = ({ "darwin-arm64": "darwin-arm64", "darwin-x64": "darwin-x64", "linux-x64": "linux-x64-gnu", "linux-arm64": "linux-arm64-gnu" } as Record<string, string>)[`${process.platform}-${process.arch}`];
  if (!platform) throw new Error("No pinned ast-grep binary configured for this platform.");
  // Install the published platform binary directly. No postinstall scripts,
  // global npm installs, project dependency changes or compilation required.
  const name = `@ast-grep/cli-${platform}`;
  const dir = await installPackages(stateDir, [`${name}@${version}`], signal);
  return join(dir, "node_modules", name, "ast-grep");
}
