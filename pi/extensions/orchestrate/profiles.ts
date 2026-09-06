export function profile(config: any, role: string, ctx: any) {
  const selected = config.roles[role];
  const model = ctx.modelRegistry.getAvailable().find((model: any) => model.provider === selected.provider && model.id === selected.model) ?? ctx.model;
  if (!model) throw new Error("No authenticated model is available.");
  return { model, thinking: selected.thinking, fallback: model.id !== selected.model || model.provider !== selected.provider };
}

export function workerArgs(base: string, packageDir: string, selected: any, promptFile: string, readOnly: boolean) {
  const tools = readOnly ? "read,grep,find,ls,web_search,web_browse,task_question" : "read,grep,find,ls,bash,edit,write,task_question";
  const args = [`${packageDir}/dist/cli.js`, "--offline", "--mode", "rpc", "--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions", "--no-approve", "--model", `${selected.model.provider}/${selected.model.id}`, "--thinking", selected.thinking, "--tools", tools, "--append-system-prompt", promptFile, "--extension", `${base}/extensions/orchestrate/worker.ts`];
  if (readOnly) args.push("--extension", `${base}/extensions/web/index.ts`);
  return args;
}
