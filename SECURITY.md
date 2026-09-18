# Security Policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/MapleStoryIdle/shapi/security/advisories/new).
Do not open a public issue for an unpatched vulnerability.

Include the affected version or commit, reproduction steps, expected impact,
and any suggested mitigation. Remove credentials, access tokens, private URLs,
session transcripts, and personal data from screenshots and logs before sending
them.

## Supported versions

Security fixes target the latest source on the actively maintained branch and
the latest published release. Older builds may require upgrading before a fix
can be applied.

## Secret handling

- Never commit `.env` files, credentials, private keys, pairing codes, tokens,
  session transcripts, or production logs.
- Use environment variables or the documented local credential stores.
- Treat a secret as compromised once it appears in Git history or a public
  artifact. Revoke or rotate it; deleting the file in a later commit is not
  sufficient.
- Before publishing a branch or release, scan the tracked tree and unpublished
  commits with a secret scanner and review every finding.

SHAPI's authentication design and credential boundaries are documented in
[`docs/agents/auth.md`](docs/agents/auth.md).
