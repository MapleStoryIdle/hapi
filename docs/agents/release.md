# Agent guide: releases

Hub/Web and Runner are separate release tracks. Decide which track changed
before building or publishing.

Do not deploy a mixed dirty worktree. Commit accepted work before starting an
unrelated change, or list every included dirty file and obtain explicit
approval. Mobile-layout changes must also satisfy `web/MOBILE_LAYOUT_CONTRACT.md`.

## Hub/Web-only

- Build and deploy Hub/Web only.
- Do not change `cli/runner-version.json`.
- Do not run `bun run build:runner-downloads`.
- Do not create, upload, replace, or prune `runner-v*` releases.

## Runner runtime or behavior

1. Bump `cli/runner-version.json`.
2. Run `bun run build:runner-downloads`.
3. Publish with:

   ```bash
   scripts/deploy/publish-runner-downloads.sh <ssh-host>
   ```

GitHub Releases hosts immutable binaries. Hub serves `install.sh` and
`latest.json`; publication retains the newest three Runner releases. Users
update manually by rerunning the installer. Hub Web may detect the version and
show/copy that command, but it must not trigger installation.

## Installer paths

- Script: `scripts/install.sh`
- Packaging: `scripts/release/prepare-runner-downloads.ts`
- Hub installation page: `web/src/routes/install.tsx`

Use the local `hapi-upgrade` skill for this machine's established production
deployment and verification workflow.
