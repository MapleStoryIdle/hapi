# Conversation detail surfaces

Scope: message tool details, terminal executions, subagents, question forms and
answer history, file/web previews, custom-URI confirmation, image viewing.
App navigation, main chat cards and composer geometry retain their existing design.

## Shared appearance

- Use `ChatDetailDialog` / `BottomDrawer`; never add a one-off sheet shell.
- Semantic tokens and shared classes: `src/styles/chat-overlays.css`.
- iOS-inspired grouped surfaces: neutral page, raised groups, restrained blue
  actions; light, dark and OLED palettes. No broad blur/glass treatment.
- Sheet corner 28px, desktop dialog 24px, group 16px, controls 14px.
- System font; 17px heading, 16px question/input, 13–15px supporting content.
  Code can remain smaller and monospaced.
- Close buttons: 44px target, 30px visible circle. Tabs/actions at least 44px.
- Selected segments use an accent edge, not only a subtle background change.
  Errors/success/warnings retain semantic colors plus text or icons.

## Behavior contract

- Phone: content-sized bottom sheet, at most 70% of the visual viewport.
- One vertical body scroller; preserve horizontal code/diff scrolling.
- Drag handle/header, outside click and Escape dismiss; busy submissions block
  dismissal. Never change question submission or URI permission semantics for styling.
- Nested sheets stack above their parent. Only the top modal dismisses; focus
  returns to its opener. Portal surfaces never move the composer.
- Keep the shared drawer/background motion and reduced-motion alternative.
- Desktop: bounded centered dialog; question/answer history keeps its sheet layout.
- Images are intentionally full-screen: gallery, pinch zoom, download, pull-down
  dismissal. Shared circular controls, dark media surface and safe-area insets.

Regression coverage: `e2e/chat-drawer.spec.ts`, drawer/question/URI/image unit tests,
and `bun run test:mobile-layout`. See `MOBILE_LAYOUT_CONTRACT.md` before changing
any header, composer, keyboard or safe-area geometry.
