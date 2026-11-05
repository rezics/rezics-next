---
goal: web
manager: web
---
# Complete the private Media return journey

Owning guide: apps/web/src/media/own-inventory/README.md. Keep the original attempt contract's navigation,
admission, bounded retention, localization and acceptance requirements.

Delivered slice: existing Next and invalid-cursor Restart now synchronously prevent navigation while the
original removal episode is sending or uncertain. Recovery explains the restriction in all eight locales.
The existing recovery test also attempts reentrant Next during confirmation and Next after uncertain settlement,
while retaining original browsing, immutable sender/command retry and acknowledged refresh assertions.

Remaining implementation:
- Keep eight admitted preceding cursor coordinates, current, and one staged target in the mounted route/outer
  page. Workspace remounts on origin.viewKey, which includes cursor; it cannot own these coordinates.
- Preserve shared address retirement. Each new address needs a current read, with loader/query coordination
  that avoids the second query currently possible because origin.seed is only true for the first boundary.
  Do not seed arbitrary authority replacements from retained loader data.
- Add Previous and First on successful later windows, including empty terminal pages. Next remains on sparse
  continuing pages. Distinguish later terminal from empty whole account. Failed movement preserves exact target
  for Retry; invalid/expired cursors require Restart. Commit only after exact target and authority admission.
- Fence reentrant movement through completion with a token that retired finally callbacks cannot release.
  Clear history/results/inspection/links/focus on all original authority replacements, equal replacement and ABA.
- Use the existing removal gate for all new movements. Add localized labels in all eight locales. Keyboard
  movement focuses heading only while the action owns focus; container return remains current-row conditional.

Remaining focused acceptance: real Router three-page remount, Previous/First and terminal return; empty/sparse
continuing; eight-coordinate retention and branch after Previous; exact failed Previous/First Retry;
malformed/expired cursors; no duplicate list request; duplicate/reentrant activation; replacement/ignored
cancellation/ABA; fresh direct visits; current inspection/container return and keyboard focus; new Previous/First
cannot discard sending/uncertain removal. Retain current selection/advice/removal assertions. Product additions
must exceed tests/stories. Add a story only for a useful missing state. No native/schema/transport changes.

Run focused changed tests using `bun apps/web/scripts/focused.ts --private-network -- bun test <files>` and
`bun run --cwd apps/web typecheck`, committing before checks and after fixes. Browser/native/root acceptance
belongs to integration; do not start builds, seeds, captures, restarts or native campaigns.
