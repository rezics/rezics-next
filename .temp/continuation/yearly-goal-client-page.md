---
goal: commerce
manager: commerce
kind: interface
paths:
  - apps/web/src/library/yearly-goal-*
  - apps/web/src/library/library-nav.tsx
  - apps/web/src/routes/library/goals.tsx
  - apps/web/src/stories/library-yearly-goal.stories.tsx
  - apps/web/tests/library-yearly-goal*
  - apps/web/messages/*.json
  - docs/library-yearly-goals.md
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
  - deletion
criticalPath: false
after: []
waiting: []
acceptance:
  tests:
    - 'After Content publishes matching generated KernelClient declarations and root export, replace the explicit unavailable shell with mounted GET/PUT reads and set, edit and clear actions. Show exact target revisions and lossless reported-year counts, known zero, unknown finish coverage, summary unavailable and over-target values. Keep target editing independent of summary availability.'
    - 'Bind drafts, requests and results to origin, shared current viewer/session and dispatch credentials, locale, selected year and operation generation. Retain original immutable command inputs and idempotency keys through lost acknowledgement, refresh, account retirement and year switches. Retry uncertain commands with their original binding, show stale conflicts without overwriting or adopting their revision, and restore dialog focus to the initiating control.'
    - 'Retain existing eight-locale metric explanation, bounded year selector, phone targets and history links. Add localized target/command presentation, page cases proving mounted API actions, and unavailable, signed-out, account-change, conflict, busy and error stories. Controller reviews seeded rendering and executes deferred original native, growth and full acceptance.'
  failing: true
estimate:
  lines: 900
  files: 15
---

# Finish the generated-client yearly completion goal journey

Use `docs/library-yearly-goals.md` as the native owner contract. Preserve the existing localized unavailable shell,
year/history links and shared current-session observation while adding the actual goal journey. The shell is not a
successful API-driven delivery. Native code already mounts the GET and PUT routes and supplies their source inputs
independently; do not couple their publication to this page finishing.

At the retained source, the installed generated `packages/client/src/kernel/http/kernel.d.ts` lacks the yearly-goal
route contribution even though `services/kernel/src/http/kernel.ts` mounts and composes it. Content owns matching
complete-input publication and root closure. Recheck the installed callable and typing before integrating. Do not
handwrite client declarations, edit generated files, use raw fetch, introduce a private generator, substitute another
summary reader or reimplement native engines. Missing generated output remains explicit unavailable.

Once installed, consume the generated KernelClient's `libraryYearlyCompletionGoal.get` and `.put` for the native
`GET /v1/libraryYearlyCompletionGoal?year=<1..9999>` and `PUT /v1/libraryYearlyCompletionGoal` contracts. PUT takes
`idempotency-key` and `{ year, metric: "completed_consumption_occurrences", target: number | null,
expectedRevision: string | null }`. Targets are optional integers 1–1000. Preserve all original authorization,
command identity, coverage, currentness and disclosure obligations. Presentation advice never grants writer access.

Show exact decimal counts and revision text; use safe arithmetic for remaining/exceeded values and cap only the visual
meter. Keep missing/unsupported finish coverage and other-history unavailability visible. An unavailable progress
summary must not prevent editing a readable target. Preserve selected year, independent target and summary currentness,
account retirement fences, retained drafts and unresolved command binding. Keep all history links without allocating
a diary slot. Add focused page action tests and stories for the remaining named states; existing shell cases do not
prove mounted API calls. Do not manufacture API conflict/busy states before the generated integration exists.

Keep minimal verification: commit before checks and after fixes; changed-workspace typecheck and changed focused tests
using `bun apps/web/scripts/focused.ts --private-network -- bun test <workspace-relative files>` from the worktree
root. Native/database/browser/remote, frozen acceptance, root and worker checks remain with the controller. Preserve
original native/growth/full acceptance obligations; historical native success on an older source is not current proof.
