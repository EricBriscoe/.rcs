# Replace custom code navigation with pi-knowledge

## Target
Remove `pi/extensions/code-navigation/`, its recipes and tests. Install stock `pi-knowledge` for indexed retrieval; do not add a replacement custom navigation layer.

## Dependents
- `setup-pi.sh`: retire owned extension links, preserve user replacements and runtime data.
- `pi/update-deps.mjs`: remove managed LSP/AST package updates.
- `pi/extensions/efficiency/runtime.mjs`: remove navigation version resolution.
- `pi/extensions/efficiency/cache.ts`: remove retired prompt marker.
- `pi/settings.json`: add the upstream package.
- `pi/launch.mjs`, `pi/native-resources.mjs`: local retrieval defaults and native dependency installation.
- `README.md`, `skills/pi-maintenance/SKILL.md`: update supported features and checks.

## Affected Stories
No release plan or epic capsules exist in this repository.

## Test Coverage
Update setup migration, updater, installed extension and cache tests. Remove navigation-only suites. Add stock knowledge loading/runtime smoke coverage and launcher environment assertions.

## Risk: Medium
Startup/update paths are shared. pi-knowledge requires native dependencies; installation scripts must be allowed only for its explicit package operations. Indexed symbol lookup does not replace LSP reference resolution. Upstream still appends a changing KB inventory to the system prompt even when automatic context injection is disabled.

## Recommended action
Proceed with scoped package installation, temporary-fixture runtime validation, and full regression tests. Do not index personal or employer files automatically.
