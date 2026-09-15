# AGENTS.md

Work style: telegraph; noun phrases okay; skip narration.

## Scope

SHAPI is a Bun/TypeScript monorepo: local agent CLI/Runner (`cli`), Hub
(`hub`), React PWA (`web`), and shared schemas/types (`shared`). Start from the
task and relevant source; **do not read the root or package README by default**.

Load only the matching guide:

| Work | Read |
| --- | --- |
| Architecture / unfamiliar area | `docs/agents/architecture.md` |
| Workspace, `spw`, `spr`, pairing, DPoP | `docs/agents/auth.md` |
| Commands, tests, local stack | `docs/agents/development.md` |
| Context/tool-output tuning | `docs/agents/context-budget.md` |
| Hub/Web or Runner release | `docs/agents/release.md` |
| Runner lifecycle | `cli/src/runner/README.md` |
| Mobile header/composer/safe-area layout | `web/MOBILE_LAYOUT_CONTRACT.md` |
| First-user experience (FUE) | `web/FUE.md` |

Package rules: `cli/AGENTS.md`, `hub/AGENTS.md`, and `web/AGENTS.md`. Read
the relevant one before changing that package.

## Required rules

- No backward compatibility; old formats may break freely.
- Pragmatism over abstraction; avoid overengineering.
- Necessary tests only.
- TypeScript strict; no untyped code.
- Runtime validation: Zod; shared schemas belong in `shared/src/schemas.ts`.
- Run Bun workspace commands from repository root.
- Indentation: 4 spaces. Package alias `@/*` maps to `./src/*`.
- Fix root causes. If unsure, inspect more code; then ask a short question.
- Treat unfamiliar dirty changes as another agent's work. Do not revert them.
- Before editing mobile layout invariants, read the contract and run
  `bun run test:mobile-layout`. Contract changes require explicit approval.

## Verification

```bash
bun typecheck
bun run test
```

Before commit/push/PR, inspect `git diff origin/main...HEAD` and apply the Major
checklist in `.github/prompts/codex-pr-review.md`. Use the `pre-push-review`
skill when available.

## Release boundary — mandatory

Hub/Web and Runner releases are independent.

- Hub/Web-only: deploy Hub/Web only. Do not bump `cli/runner-version.json`,
  build Runner downloads, or publish `runner-v*`.
- Runner behavior/runtime: bump `cli/runner-version.json`; run
  `bun run build:runner-downloads`; publish with
  `scripts/deploy/publish-runner-downloads.sh <ssh-host>`.
- Runner updates remain manual through the Hub installer. Web may display the
  command but must not trigger an update.

## Context and output budget

- Read the smallest relevant source range; search before opening large files.
- Do not preload reference docs “just in case.”
- Keep successful command output to status/counts. Capture noisy output and
  print only the useful summary.
- On failure, show the relevant error and a short tail; never dump generated or
  minified bundles.
- Avoid repeating plans, repository descriptions, or completed findings.
- Start a fresh session after a completed feature/release; carry only a short
  handoff or session reference.
