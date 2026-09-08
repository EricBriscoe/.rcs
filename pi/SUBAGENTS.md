# Subagents

Stock [pi-subagents](https://github.com/nicobailon/pi-subagents), unversioned in `pi/settings.json`. Setup installs it; launches check updates. No custom coordinator, policy wrapper or fixed role models. Follow `pi/AGENTS.md`; `pi --list-models openai` lists candidates, not guaranteed entitlement.

- `/subagents-guide`: installed-version docs/workflows.
- `/subagents-fleet`: inspect, steer, stop children.
- `/subagents-models`: role/model mapping.
- `/subagents-doctor`: diagnostics.

Pi owns discovery and child lifecycle. Pi `/session` and fleet report delegated usage; `/tokens` counts instrumented sessions independently. Existing sessions retain loaded code until restart.
