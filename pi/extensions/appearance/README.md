# Appearance

Default: `quiet-graphite`; alternative: `paper` in `/settings` → Theme. Theme edits hot-reload; restart after setup for new extensions/defaults.

`/appearance stock|compact` switches footer/spinner for this session. Compact shows directory/branch, model/thinking, context and Codex pool status. Unknown, stale, reset and exhaustion information stays visible; long statuses wrap. Other extension statuses and stock subagent widgets are preserved without private APIs or extra polling.

Details: `/session`, `/tokens`. Defaults hide thinking (toggle in `/settings`) and cache/recovery diagnostics (`showCacheMissNotices` in `pi/settings.json`), quiet startup, condense changelogs and pad input. Errors, retries, approvals and failover notices are not intercepted.

## Terminal pairing

Themes do not change the terminal background/font. Set iTerm → Settings → Profiles → Colors:

| Theme | Background | Foreground |
|---|---|---|
| `quiet-graphite` | `#191b20` | `#dedee3` |
| `paper` | `#faf4ed` | `#363638` |

Paper requires a light terminal profile. No terminal settings are changed automatically. `pi --use-theme paper/quiet-graphite` follows detected terminal appearance.
