---
name: schlep
description: Commit all changes, sync main, resolve conflicts, and push. Use only when explicitly invoked, not when discussing this skill.
---
# Schlep

Invocation authorizes this workflow without repeat confirmation; explicit limits win.

1. Verify repo, branch, and remote. Inspect status, diffs, and outgoing commits yourself. Stop on detached HEAD, ambiguous destinations, or apparent secrets/private state (report paths, not values). No reviewers or other harnesses.
2. Finish existing merges/rebases when intent is clear; preserve both sides' behavior. Stop on ambiguous conflicts or unrelated cherry-pick/revert state. Never abort/discard automatically.
3. `git add -A` at the root includes all non-ignored changes, including pre-existing work and deletions. Commit staged changes descriptively; if empty, still push pending commits. Do not repeatedly sweep new edits.
4. Fetch and integrate the verified remote's main/default branch. Prefer merge for published PR branches; continue existing rebases. Resolve safe conflicts. No new history rewrite or force-push without explicit authorization.
5. Run required checks, coverage gates, and hooks on the final tree. Fix related regressions and rerun; stop on blockers, not merely missing coverage. Never bypass/weaken checks or make unrelated fixes. `pi-maintenance` permits Markdown-budget repair.
6. Push commits and integration, including earlier unpushed commits, to the configured upstream using an explicit remote/refspec; ask if missing/ambiguous. This includes main/default when working there. Stop on rejection/divergence; never automatically pull/rebase after rejection. Never merge the PR or deploy.
7. Report hashes, push/check results, remaining changes and risks. Tests alone do not establish merge safety.

No branch switching, amend, stash/discard, force-add, or unsolicited implementation.
