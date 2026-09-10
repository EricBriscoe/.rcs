# Subagents

Stock [pi-subagents](https://github.com/nicobailon/pi-subagents), unversioned and launch-updated. No custom coordinator, wrapper or fixed role models. `pi --list-models openai` lists candidates, not guaranteed entitlement.

- `/subagents-guide`: installed-version docs/workflows.
- `/subagents-fleet`: inspect, steer, stop children.
- `/subagents-models`: role/model mapping.
- `/subagents-doctor`: diagnostics.

## Long-running work

Setup links `pi/subagents.json` to `<agentDir>/extensions/subagent/config.json`: 72-hour child defaults, 1,024 admissions/run, unlimited session admissions. Concurrency stays 20; advisory inactivity/active-tool notices use 15/30 minutes.

- Omit overall async workflow deadlines. For massive tasks, set `timeoutMs: 259200000` on each new `runs.run`/`runs.all` child to override shorter profiles; pass this guidance to nested delegates. Avoid hard tool/tight usage budgets for writers. Explicit deadlines remain coordinator decisions.
- Steer with `mode: "follow_up"` (queued) or `mode: "auto"` / `steeringRecovery: false` (no automatic pause-and-revive). Check acknowledgments. Before deliberate interruption, request a checkpoint after tool completion: changed files, validation, remaining work.
- Preserve missions/artifacts; yield for native async wakeups. Do not reload/restart the owner while workflows are active.

**Remaining limits (0.66.0):** 72 hours is a hard deadline, not unlimited. Explicit/profile overrides and legacy async chain/parallel agent deadlines can be shorter. Fast built-ins retain 5-minute timeouts; transport/tool/verification limits remain. `bg_wait` expiry leaves work running; headless `agent_end` auto-drain still fails after 30 minutes. Steering recovery is disabled per call, not globally. Existing runs retain captured limits; restart after setup once work settles.

Pi owns discovery and lifecycle. `/session` and fleet report delegated usage; `/tokens` counts instrumented sessions independently.
