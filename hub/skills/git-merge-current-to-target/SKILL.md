---
name: git-merge-current-to-target
description: Commit and push the current branch, then safely merge it into a target branch with separate target-push confirmation. Use only when the user requests current branch to target branch delivery.
---

# Git Merge Current To Target

Safely deliver **current branch → target branch**. Never merge the target back into the source. Repository instructions and explicit user limits always win.

## Required input

Require a target branch. If absent, ask for it and do not mutate Git.

A commit message is optional. If absent, inspect `git status --short`, `git diff --numstat`, and `git diff --name-only`, then create a short message in the user's language. For large changes (>12 files, >800 changed lines, >300 lines in one file, or generated-file churn), use a coarse module-level message instead of reading the full diff.

## Safety gates

Stop when:

- source equals target;
- HEAD is detached;
- merge, rebase, or cherry-pick is already active;
- the requested direction is not current → target.

If there are no uncommitted changes and no local commits ahead of `origin/current`, require explicit confirmation before merging the existing source HEAD.

A clean local target merge does not authorize pushing the target. Ask separately before the target push. Commit/push/deploy permission never comes from merely selecting this Skill.

## Main workflow

Run from the repository root, resolving this path from the Skill bundle root:

```bash
scripts/merge_current_to_target.sh <target-branch> <commit-message>
```

The script validates state, commits local changes, fetches and rebases the source on `origin/source`, pushes the source, updates the local target, creates a `--no-ff` merge commit, records guarded state, and switches back to the source. It never pushes the target automatically.

If it prints `CONFIRM_CONTINUE_REQUIRED`, ask the user. After approval run:

```bash
scripts/continue_merge_current_to_target_after_confirmation.sh <target-branch>
```

If it prints `MERGE_LOCAL_SUCCESS`, report source, target, source commit, local merge commit, and state-file path. Ask whether to push the target or cancel the local merge.

After explicit push approval:

```bash
scripts/push_target_after_confirmation.sh <target-branch>
```

After explicit cancellation approval:

```bash
scripts/cancel_target_merge_after_review.sh <target-branch>
```

## Conflicts

For 1–3 conflict files, do not edit. Inspect only the conflicted files and nearby history, explain both intents and a recommended resolution, then immediately abort the rebase or merge. Ask before starting a separate manual-resolution task.

For more than three conflict files, abort immediately without detailed analysis. Never stage, commit, or push conflict resolutions inside this scripted workflow.

Useful read-only commands:

```bash
git status --short
git diff --name-only --diff-filter=U
git diff -- <path>
git log --oneline -n 20 --all -- <path>
git show <commit>:<path>
```
