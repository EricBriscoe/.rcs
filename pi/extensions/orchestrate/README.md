# Native Pi orchestration

An opt-in dispatcher for independent, rapid-fire text tasks. Normal Pi never dispatches background agents. Start with `/orchestrate on`; each ordinary message is durably acknowledged before any planning/model request. This is a native Pi extension, not Python or another coding harness.

## Controls

- `/orchestrate on`: start intake and drain queued/ready tasks. Always off at startup, session change and reload; never resumes interrupted workers automatically.
- `/orchestrate off`: stop intake and owned workers, preserve edits, keep queued tasks for the next `on`. Active tasks become paused. This is not rollback.
- `/orchestrate status`: task board, approved project aliases and command help. The persistent widget shows eight pending tasks; `show` can inspect any ID from this session.
- `/orchestrate show 12`: inspect the request, plan, state, result and local run-log path.
- `#12 <text>` or `/orchestrate reply 12 <text>`: answer a waiting task, or stop/replan that task with an amendment. Replies are saved for later recovery. Other independent tasks are unaffected.
- `/orchestrate cancel 12`: stop only that task and fence its old result. Partial files/external effects remain.
- `/orchestrate resume 12`: explicitly requeue paused, failed, blocked, cancelled or completed work. Inspect partial changes first. Previously completed dependent tasks are historical results, not automatically rerun validations.
- `/orchestrate project <alias> <absolute path>`: explicitly approve a workspace for future routing. Aliases are machine-local, shared between Pi sessions. `current` is reserved; `rcs` and `research` are defaults which can be overridden.
- `/orchestrate models`: configured roles, currently authenticated catalog matches and fallback choices.

A message **starting** with `#12` is a reply/amendment. To submit new dependent work, say “Use #12 to update app.” Dependencies can only refer to earlier task IDs explicitly mentioned by the user, within the current session. The scheduler waits for success; failed/cancelled dependencies need user action. Bounded dependency reports are passed as untrusted evidence, never as extra authorization.

The CLI and RPC client must remain alive to do work; there is no launchd job or daemon. Use interactive Pi or a persistent RPC connection, not a short-lived `pi -p` invocation. Project trust is required. Attachments are not accepted in v1; save them to the project and reference their paths.

## Models and scheduling

`pi/orchestrator.json` is the portable, fixed allowlist:

| Role | Default model | Thinking | Use |
| --- | --- | --- | --- |
| coordinator | openai-codex/gpt-6-astra | low | Tool-free bounded JSON routing |
| scout | openai-codex/gpt-5.4-mini | low | Read-only files and public web lookups |
| worker | openai-codex/gpt-5.5 | medium | Straightforward coding |
| strong | openai-codex/gpt-6-astra | high | Difficult debugging, architecture, uncertainty |

All requests use Pi's existing login. Model names are selected from configured roles, never arbitrary planner output. If a configured model is absent from Pi's authenticated catalog, the current Pi model is used and labeled as a fallback. Catalog presence does **not** prove subscription entitlement: an API rejection fails the task without silently retrying possibly side-effecting work. Change the profile, `/reload`, turn orchestration on again, and explicitly resume after inspecting the task. GPT-5.4 was present in the catalog but rejected by the tested ChatGPT account; GPT-5.5 and GPT-5.4-mini were verified live.

One coordinator request runs at a time, separate from the main chat model. Up to three workers actively execute; up to eight total workers may exist when some are waiting for user input. Each worker has a 15-minute wall-clock limit (including waiting) and a 100-tool-call cap. The queue allows 100 unresolved tasks. Coordinator calls have a 60-second timeout and 2,048 output-token cap. These are safety bounds, not a dollar-budget guarantee.

SQLite transactions serialize writers by Git-common-directory identity, including worktrees and other orchestrator instances. Nested non-Git workspace paths also conflict. Readers may overlap readers but not writers. A waiting writer retains its workspace lock; unrelated projects can continue. Locks cover orchestrator-owned tasks, not the normal main agent, another editor or arbitrary processes. Do not run an independent writer against an active task's workspace. Parallel worktree writers/integration are intentionally not implemented.

## Native resources, tools and memory

Workers explicitly disable inherited context, skills, prompts, themes, extensions, sessions and project settings. They receive:

- this checkout's Pi-owned instructions;
- the selected workspace's real `.pi/AGENTS.md`, if any;
- their original user request, bounded routing guidance and declared dependency reports;
- bounded read-only memory for that workspace plus explicitly approved global notes, honoring recall-off controls.

They do not receive the full coordinator chat, other tasks' transcripts, home-directory memories, or other harness instructions. Native `read/edit/write/grep/find/ls` paths are checked against the workspace and approved Pi documentation roots, including symlink resolution. Scouts have no shell or file-write tools and cannot click/fill/press browser controls. Coding workers have shell access: **this is not an OS sandbox**. The workspace/publishing/no-recursion rules are instructions for trusted coding work, not containment against malicious shell commands. No recursive dispatch tool or unrelated global extensions are loaded.

A worker's `task_question` uses Pi's native RPC input dialog. The parent surfaces it beside the task ID without opening a blocking foreground modal. Only that worker waits, until a real `#ID` answer or the wall-clock deadline. An answer is held if all active-worker slots are occupied, then forwarded when a slot opens. Blank input/cancellation is never approval. Expired questions require inspection and explicit resume, not blind replay.

Workers do not load the memory learner. Task updates remain in UI/history but are filtered from the main model's context. Delegated briefs and raw worker transcripts do not become home-directory user facts. **V1 reuses memory read-only; automatic task-outcome learning is deferred.** Normal non-orchestrated Pi memory continues operating automatically.

## Results and recovery

A successful worker must report changes and actual checks. The coordinator additionally runs `git diff --check` for coding tasks in Git; this is whitespace validation, not independent functional verification and does not cover untracked files. A model's success report is not proof that the requested feature works. There is no automatic review agent, commit, push, deploy, publishing or destructive-operation approval path. Use normal Pi for explicitly authorized publishing after tasks settle.

Cancellation/revision invalidates late results. Workspace locks are not released until worker cleanup finishes. RPC prompt acceptance is not completion: workers wait for `agent_settled`, including native retries, not `agent_end`. Cleanup clears continuations, aborts, and then terminates observed descendants/process groups, escalating if necessary. This cannot guarantee cleanup of arbitrarily daemonized shell commands; inspect services started by a task.

After a crash, a dead owner's expired 120-second lease becomes paused on the next `on` or active recovery poll; no side-effecting work is automatically repeated. A still-live owner is not stolen. PID reuse can conservatively delay recovery. Resume the same Pi session to inspect/resume its tasks. Session changes/reload stop owned workers and reset mode to off.

## Local state and privacy

State is under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/orchestrator/`, never in `.rcs`:

- `tasks.sqlite`: original requests, replies, plans, states, results and approved project aliases;
- `runs/<task>-<revision>-<uuid>/instructions.txt`: that worker's bounded Pi instructions and recalled context;
- `runs/.../events.jsonl`: up to 1 MB of tool names/IDs/outcomes, not thinking or full tool/file bodies; failures also get a bounded, redacted `.error` diagnostic;
- `research/`: an empty workspace for public lookups.

The directory/database are private (0700/0600). UI summaries/errors use best-effort redaction. Original task requests and replies are retained in the private database, so do not paste credentials. Run instructions can contain recalled notes. This is not encrypted storage, an automatic retention policy, or forensic erasure. Memory forgetting does not delete task history, run instructions, old Pi chats or backups. Do not sync this directory into Git or Obsidian.

## Checks

```sh
node --test tests/pi-native-resources.test.mjs tests/pi-orchestrate*.test.mjs
PI_ORCHESTRATE_LIVE=1 node --test tests/pi-orchestrate-live.test.mjs
```

The default tests exercise durable intake, scope/role validation, resource locks, dependencies, targeted replies, revision fencing, dead-owner recovery, native loading/reload/trust, file guards and real RPC dialogs without model usage. The optional live test performs actual routing and two coding jobs in disposable files, removes only its own synthetic task records/logs, and never copies authentication files.
