# First-user experience (FUE)

Use the generic FUE primitive for useful but non-essential features.

- Hook: `src/lib/use-fue.ts`; `useFue(featureId)` returns
  `{ status, engage, dismiss }`.
- Components: `src/components/Fue.tsx`; use `FueDot` on the affordance and
  `FueCallout` for the anchored explanation.
- Storage: `hapi.fue.v1.<featureId>`; one isolated localStorage key per feature.
- No auto-timeout. The user acknowledges with the affirmative action.
- FUE dot and feature inventory badge are mutually exclusive until acknowledged.
- If upstream provides onboarding, do not wrap the same affordance.

Canonical example: `ScratchlistToggleButton` in
`src/components/AssistantChat/ComposerButtons.tsx`.
