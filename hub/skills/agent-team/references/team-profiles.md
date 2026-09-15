# Team Profiles

Use the smallest profile that provides useful independent evidence.

## Complexity

- **L0** — explanation or tiny deterministic edit; no meaningful uncertainty.
- **L1** — one bounded component, obvious verification, no material risk.
- **L2** — several files or one uncertain subsystem; a scout or verifier may help.
- **L3** — cross-package feature, protocol/state change, migration, or production-sensitive work.
- **L4** — destructive migration, security boundary, high-impact production change, or several independent unknowns.

## Profiles

### P0 — Solo

Use for L0/L1. Lead investigates, edits, tests, and reports.

### P1 — Scout + Lead

Use when the implementation is bounded but facts are uncertain. Scout is read-only; lead writes and verifies.

### P2 — Lead + Implementer + Verifier

Use for L2/L3 when implementation can be isolated. Only one writer owns a given file set. Verifier is read-only and checks behavior after the writer finishes.

### P3 — Staged specialists

Use for L3/L4 across distinct subsystems. Run scouts in parallel, then assign non-overlapping writers, then an independent verifier. Never run overlapping writers concurrently.

## Escalation

Escalate only when evidence shows the smaller profile is insufficient. Risk, not file count alone, controls the profile. A tiny authentication or deletion change may require more review than a large text-only refactor.
