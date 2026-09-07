# Subagents

Stock [pi-subagents](https://github.com/nicobailon/pi-subagents), pinned in `pi/settings.json`. No custom coordinator, policy wrapper, ON/OFF gate, or fixed role/model assignments. Model selection follows `pi/AGENTS.md`; `pi --list-models openai` lists authenticated candidates. Catalog presence is not a guarantee of provider entitlement.

- `/subagents-guide`: installed-version documentation and workflows.
- `/subagents-fleet`: inspect, steer, or stop children.
- `/subagents-models`: live role/model mapping.
- `/subagents-doctor`: diagnostics.

Pi handles package discovery; `setup-pi.sh` installs the pin. Runtime state and child lifecycle follow upstream behavior. Use Pi's `/session` and the fleet for delegated usage; local `/tokens` records each instrumented session independently.

The retired runtime's code/config/tests are removed. Its existing local task data is not migrated or erased. Restart Pi after upgrading.
