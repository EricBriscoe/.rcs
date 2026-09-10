---
name: schlep
description: Stage and commit all current repository changes, then push. Use only when invoked or explicitly asked to schlep, not when discussing this skill.
---
# Schlep

1. Find the repository containing cwd; otherwise ask. Stop on detached HEAD, conflicts, or an active merge/rebase/cherry-pick/revert.
2. Inspect status, diffs, and outgoing commits yourself. Stop on apparent secrets/private state; report paths, not values. No reviewers or other harnesses.
3. Run `git add -A` at the root, including pre-existing, staged, unstaged, deleted, and untracked non-ignored changes. Do not silently omit files or force-add ignored ones.
4. If staged changes exist, make one descriptive commit; otherwise skip committing but still push pending commits. Honor checks/hooks; stop on failure except `pi-maintenance`'s Markdown-budget repair.
5. Push the current branch to its configured upstream using an explicit remote/refspec. If missing or ambiguous, ask for the destination. Invocation authorizes this push, including earlier unpushed commits. Stop on rejection; never force-push or automatically pull/rebase.
6. Report commit hash, push result/destination, and remaining changes. Do not repeatedly commit newly arriving edits.

No branch switching, amend, stash/discard, bypassed hooks, unsolicited implementation or unrelated check-fixing edits.
