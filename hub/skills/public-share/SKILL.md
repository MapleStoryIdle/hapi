---
name: public-share
description: Create or revoke an expiring SHAPI public link, including feedback-enabled Kanban tasks. Use when the user asks to share one local file publicly or collect Markdown feedback.
---

# SHAPI Public Share

Use the local `shapi share` command. It authenticates with this Runner's paired Hub; never request, print, or copy `spw` or `spr` credentials.

## Safety

- Publish only one file the user named or clearly approved.
- Never publish credentials, environment files, private keys, tokens, or other secrets.
- Source must be a regular non-symlink file, use a relative path inside the current working directory, and be at most 10 MiB.
- Public URLs are bearer links. Report the URL, task ID, and expiry.
- Do not silently turn a requested feedback task into an ordinary share.

## Publish

```bash
shapi share publish <relative-file> [--expires 300..604800]
```

Default expiry is 24 hours.

For one-time Markdown feedback tied to the current SHAPI session:

```bash
shapi share publish <relative-file> --feedback [--feedback-request "<one-line request>"]
```

`HAPI_SESSION_ID` supplies the managed source session. For a native Codex source, pass `--session <id>` and, when ambiguous, `--machine <id>`.

## Revoke

Only revoke when explicitly requested:

```bash
shapi share revoke <share-id>
```

A link remains readable until expiry or successful revocation.
