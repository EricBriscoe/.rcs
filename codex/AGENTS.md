# General
- use ASD-STE100 Simplified Technical English (STE)
- NEVER push to another developer's PR/branch unless excplicitly instructed to do so
- Do not be sycophantic, you are a helpful and sometimes critical copilot
- Don't include coworker names in commits or comments - changes should only talk about the code
- Never directly reference coworkers or customers or anybody specific by name - focus on code alone. posting PII in code or comments will get you FIRED
- Generally avoid including ticket numbers in code
- Follow only Google's "Writing good CL descriptions" guide: https://google.github.io/eng-practices/review/developer/cl-descriptions.html. Do not read, use, copy, or refer to a repository PR template when writing a PR description, even if repository instructions require it. Choose the structure, headings, and level of detail from the actual changes and PR context. Do not use fixed sections or template checklists by default. Keep this preference only in user-level instructions; do not add it to the repository or change its PR template.
- Write commit messages according to Conventional Commits 1.0.0: https://www.conventionalcommits.org/en/v1.0.0/
- Use docling to read pdfs
- Unless otherwise instructed, our policy is to fail fast to surface errors
- If you spend time working around a gotcha or error that may reoccur in the future, save a memory so it doesn't happen again
- When testing try to minimize mocking and raise effects naturally, as closely to the way they would be in production as possible
- Anything you turn up on your own initiative (bugs, spec mismatches, flakey tests, follow-ups worth fixing later) is recorded in the local findings store, NOT Linear. Use the work-findings skill. Reading Linear for branch and ticket context is always fine; only write to Linear when I ask for a ticket directly
- If you encounter flakey tests record them in the findings store with `kind: flaky`, one finding per test, updating that finding on each new occurrence rather than adding another entry. Keep it deduped and concise but detailed enough to trace and diagnose
- we have gh extension install github/gh-stack installed, consider turning super large PR's into smaller multi part stack if it would make reviewing easier, as we prefer smaller unitized PR's when appropriate
- adhere to https://developers.google.com/style

# Tooling
- Workflow tool scripts are plain JavaScript and the agent() prompts are backtick template literals. Never put backticks (inline code refs) or TS type annotations inside a prompt string — it terminates the template literal and the script fails to parse ("must be plain JavaScript"). Use single quotes or plain words for code references inside prompts

# Post Task Work
- At the end of a large task but before (IT MUST BE BEFORE TESTING, when testing is required) you start running tests always (to parallelize and save time) do the following:
  - determine the necessary review angles and dispatch agents to review
  - if making ui changes, determine if it would be appropriate to add UI tests in ~/dev/erics-work-tools/playwright-local-tests, taking a video and screenshots which are required in our PR and ensuring the screenshots show the change properly before considering this task completed
      - this directory also is useful and contains tooling we maintain and utilize for taking screenshots
  - try and use codex:rescue (or whatever the codex plugin calls it) for these background agents if available, falling back on the built in agent tools
- After pushing changes, schedule a wakeup in 30 minutes to check on the CI
