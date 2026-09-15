# CLI agent rules

- Read `../docs/agents/auth.md` for credentials, pairing, or DPoP work.
- Read `src/runner/README.md` for Runner lifecycle or control changes.
- Agent integrations live under their named directories; preserve native event
  semantics before normalizing them into shared messages.
- Runner runtime changes require the independent release path in
  `../docs/agents/release.md` and a Runner version bump.
- CLI-only documentation or packaging changes do not automatically require a
  Runner release; decide by shipped runtime behavior.

