# Agent context budget

Purpose: keep routine code changes fast and prevent repeated history or command
output from dominating model input.

## Defaults

- Open the task's source and nearest tests first.
- Read one task guide only when its trigger applies.
- Search large files and open bounded ranges.
- Do not copy source, docs, plans, or tool output back into the conversation
  unless needed for a decision.
- Summarize successful checks in one line.
- Preserve full logs outside the conversation; expose only relevant failures.
- End completed work cleanly. Use a new session for an unrelated feature.

## Optional lean Codex profile

Machine-level plugin settings affect every repository and are intentionally not
changed by this project. For routine coding, consider a separate profile that
disables Sites, browser/Chrome, Visualize, and computer-use plugins. Enable them
only for tasks that need those capabilities. Measure a new session before and
after; plugin availability and tool schemas vary by Codex version.

