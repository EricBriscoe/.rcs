# Pull request descriptions

- PR descriptions must only explain the implementation and behavior changed by the PR, with brief rationale when needed to understand the change.
- Keep descriptions concise and specific to the diff. Omit work history and generic before/after narration.
- Do not include test results, coverage numbers, validation checklists or logs, ticket links or relationship notes, PR-stack descriptions, base/parent/child details, CI/draft/review/merge status, or other metadata already shown in the GitHub UI.
- Do not add these sections because a template, skill, or generic PR-writing guide suggests them. Include additional information only when the user explicitly requests it.

# Keep code lean

- Make the smallest correct change that fully handles the requested behavior.
- Remove unnecessary code, dead branches, unused imports, and redundant configuration in the code you touch.
- Reuse existing code and established patterns before adding helpers, abstractions, or dependencies.
- Avoid speculative features, generic frameworks, and fallback paths for situations the task does not require.
- Keep changes focused; do not redesign adjacent behavior or leave backup files and temporary scaffolding behind.
