# Design QA

## Comparison target

- Source visual truth: `/Users/dev/.codex/generated_images/019ff99e-7ad1-7761-841b-4441315c9d36/exec-20360af9-876e-467e-bc0b-f794988da451.png`
- User-approved interaction update: recent Codex rows navigate to a read-only transcript detail; the composer is replaced by one Fork action.
- Target state: desktop `/sessions` list and a selected read-only local Codex transcript at 1440 × 1024 CSS px.

## Implementation capture

- Implementation screenshot path: unavailable — the Codex Desktop in-app Browser (`iab`) is not available in this session.
- Source dimensions: 1488 × 1058 px; implementation dimensions and device-pixel ratio: unavailable.
- Density normalization: not applicable without a browser-rendered implementation image.
- Primary states checked in code and tests: list row navigation, transcript loading, no text input, Fork action, Fork success navigation, and back navigation.

## Comparison evidence

- Full-view comparison: blocked because no implementation screenshot can be captured.
- Focused-region comparison: blocked for the same reason. The critical regions would be the compact recent-session row and the read-only page footer that replaces the composer.

## Required fidelity surfaces

- Fonts and typography: existing application font stack and title / metadata hierarchy are used; visual capture unavailable.
- Spacing and layout rhythm: compact session rows, fixed detail header, scrollable conversation, and bottom Fork bar are implemented; visual capture unavailable.
- Colors and tokens: only existing `--app-*` semantic tokens are used; visual capture unavailable.
- Image and asset fidelity: no new raster assets are required; existing Lucide icon set is used consistently with the surrounding implementation.
- Copy and content: list rows expose only title and last active time; the transcript remains read-only and Fork is the sole bottom action.

## Findings

- [P1] Browser-rendered visual comparison is blocked.
  - Location: `/sessions` and `/sessions/codex/:id`.
  - Evidence: the in-app Browser selection returned `Browser is not available: iab`.
  - Impact: visual parity with the reference cannot be asserted from code or unit tests alone.
  - Fix: capture the two target states with the in-app Browser at 1440 × 1024, compare them with the source in one input, and address any P1/P2 differences.

## Comparison history

- 2026-08-13: attempted in-app Browser capture; selection failed before a browser-rendered page or console could be inspected. No visual fixes can be validated yet.

## Implementation checklist

- [x] List recent rows as title plus last-active time only.
- [x] Navigate row clicks to a machine-scoped local Codex transcript route.
- [x] Render the transcript read-only and replace the composer with Fork.
- [x] Verify focused component tests, route resolution, TypeScript, and production build.
- [ ] Capture and compare the live page in the in-app Browser.

## Follow-up polish

- Check desktop and mobile scroll behavior once browser capture is available.

final result: blocked
