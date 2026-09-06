import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Pi-native sources only. Never discover ancestor AGENTS/CLAUDE files or
// shared .agents/.claude/.codex skills. Explicit CLI paths remain user choices.
export function nativeArgs(args, checkout) {
  if (["install", "remove", "uninstall", "update", "list", "config", "auth"].includes(args[0])) return args;
  const result = ["--no-context-files", "--no-skills", "--no-prompt-templates", "--no-extensions"];
  const has = (...flags) => flags.some(flag => args.includes(flag));
  const base = join(checkout, "pi");
  if (!has("--no-context-files", "-nc")) result.push("--append-system-prompt", join(base, "AGENTS.md"));
  if (!has("--no-extensions", "-ne")) {
    const dir = join(base, "extensions");
    for (const name of readdirSync(dir).sort()) {
      if (name === "project-context" && has("--no-context-files", "-nc")) continue;
      const entry = join(dir, name, "index.ts");
      if (existsSync(entry)) result.push("--extension", entry);
    }
  }
  for (const [dir, flag, disabled] of [["skills", "--skill", has("--no-skills", "-ns")], ["prompts", "--prompt-template", has("--no-prompt-templates", "-np")]]) {
    if (!disabled && existsSync(join(base, dir))) result.push(flag, join(base, dir));
  }
  return [...result, ...args];
}
