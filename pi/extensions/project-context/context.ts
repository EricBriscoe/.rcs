import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

export async function projectInstructions(cwd: string): Promise<string> {
  try {
    const root = await realpath(cwd);
    const path = join(root, ".pi", "AGENTS.md");
    // Do not follow links into another harness or outside this explicit Pi scope.
    if (await realpath(path) !== path) return "";
    return (await readFile(path, "utf8")).slice(0, 20000);
  } catch { return ""; }
}
