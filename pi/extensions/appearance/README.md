# Appearance

Default: `quiet-graphite`; alternative: `paper` in `/settings` → Theme. Theme edits hot-reload; restart after setup for new extensions/defaults. The TUI starts in fullscreen mode (`tuiMode` in `pi/settings.json`); switch it in `/settings` → TUI mode, which saves through the settings link and is kept.

`/appearance stock|compact` switches the footer and working indicator for this session. Compact animates a small glint along the editor's top border while Pi works, using Pi's native redraw timer. The border returns to normal when work stops; retry and compaction loaders stay unchanged. Compatible custom editors, including `pi-vim`, keep their editing controls and mode labels while displaying the glint. Editors without Pi's working-status interface retain the dot spinner.

Run `/reload`, then send a prompt to try the glint. Use `/appearance stock` to restore the stock editor, indicator and footer.

Compact shows directory/branch, model/thinking, context and Codex pool status. Unknown, stale, reset and exhaustion information stays visible; long statuses wrap. Other extension statuses and stock subagent widgets are preserved without private APIs or extra polling.

Details: `/session`, `/tokens`. Defaults hide thinking (toggle in `/settings`) and cache/recovery diagnostics (`showCacheMissNotices` in `pi/settings.json`), quiet startup, condense changelogs and pad input. Errors, retries, approvals and failover notices are not intercepted.

## Terminal pairing

Themes do not change the terminal background/font. Set iTerm → Settings → Profiles → Colors:

| Theme | Background | Foreground |
|---|---|---|
| `quiet-graphite` | `#191b20` | `#dedee3` |
| `paper` | `#faf4ed` | `#363638` |

Paper requires a light terminal profile. No terminal settings are changed automatically. `pi --use-theme paper/quiet-graphite` follows detected terminal appearance.
