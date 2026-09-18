# Web agent rules

- Routes: `src/routes/`; reusable UI: `src/components/`; server state:
  `src/hooks/queries/` and `src/hooks/mutations/`; API: `src/api/client.ts`.
- Before changing session header transparency, safe areas, composer/keyboard
  offsets, or message clearance, read `MOBILE_LAYOUT_CONTRACT.md` and run
  `bun run test:mobile-layout` from the repository root.
- Contract changes require explicit approval and coordinated implementation,
  contract, guard, and regression-test updates.
- For non-essential feature discovery, read `FUE.md`; do not add large,
  permanently visible onboarding blocks.
