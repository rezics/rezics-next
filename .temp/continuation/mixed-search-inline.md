---
goal: search
manager: search
kind: implementation
paths:
  - services/kernel/src/search/default-discovery.ts
  - services/kernel/src/search/discovery-http.ts
  - services/kernel/src/search/discovery-query.md
  - services/kernel/test/search/discovery*.test.ts
  - services/kernel/test/search/second-scope-mixed-query.test.ts
  - apps/web/src/search/discovery.ts
  - apps/web/src/search/discovery-results.tsx
  - apps/web/src/search/discovery-personal-actions.ts
  - apps/web/src/search/discovery-personal-controls.tsx
  - apps/web/src/search/discovery-personal-state.ts
  - apps/web/src/search/discovery-public-results.md
  - apps/web/tests/search-mixed-personal-actions.test.tsx
  - apps/web/tests/search-mixed-public-results.test.tsx
  - apps/web/messages/*.json
riskAreas:
  - authorization
  - disclosure
criticalPath: false
after:
  - 643e5e65-25db-489a-9c0f-144ac75d1c95
  - 360f7b9b-415b-4952-9625-c349ed050b0f
  - 6815c098-55d3-417b-8eec-007ad47d03ff
waiting: []
acceptance:
  tests:
    - An admitted mixed semantic result displays current private state and offers native save/state/change/remove and supported question-bound score set/clear controls without opening its Subject page. Every write uses an existing native command port and reauthorizes.
    - "Pending, rejected, uncertain, successful and retired commands have distinct behavior; a stale viewer, credential, row identity, question, request, locale or page cannot dispatch, publish or roll back into another reader's state."
    - "Preserve complete-page retirement on false viewerFactsCurrent, including empty/final pages, and ordinary producer-unavailable public-page retention; mutation refresh uses that same final admission lifecycle."
    - "Controls preserve query/filter/order/scroll and keyboard focus, duplicate identities reconcile from one authoritative refreshed page, zero differs from absence, and all named outcomes work in eight locales."
    - "Page refresh and mutation reconciliation have finite aggregate native work and byte bounds without per-row reads, unbounded retry, private public-cache fields or a second entry/vote writer; focused tests and changed-workspace typing follow launch policy."
estimate:
  lines: 1700
  files: 18
---

# Finish inline personal actions in live mixed Search

The retained source supplies controlled entry controls, native Library entry input construction and a page action lifetime
in `apps/web/src/search/discovery-personal-{controls.tsx,actions.ts,state.ts}`. The owner contract is
`apps/web/src/search/discovery-public-results.md#controlled-personal-actions`. These building blocks are not wired to the
live mixed Search page. Complete that journey rather than treating the controlled seam as the finished outcome.

Preserve `readAdmittedDiscoveryPage` in `services/kernel/src/search/default-discovery.ts`, the preparation-before-checkout
staging, released repeatable-read snapshot, original/terminal/source checks, final viewer/public guards and cleanup. A false
final viewerFactsCurrent retires the entire page, including empty/final pages, without automatic retry. Ordinary producer
unavailability retains an independently current public page. Existing focused regressions are in
`services/kernel/test/search/discovery-personal-admission.test.ts`.

Read `services/kernel/src/search/discovery-query.md` and the native APIs and exposure/session safeguards used by
`apps/web/src/features/pages/subject-library-leaf.tsx`, `apps/web/src/library/subject-slot-view.tsx`,
`apps/web/src/features/pages/rating-actions.ts` and `rating-control.tsx`. Reuse native command adapters and view primitives.
Extract only minimal reusable seams. Do not mount SubjectLibraryLeaf per result, create another native storage path or
entry/vote writer, invent native DTOs or substitute client permission for native server authorization.

Supply released writable profile choices and exposure evidence through one bounded page-level seam, independently of
entry existence. Integrate controlled save/state/change/remove entry controls into general mixed Search. Supply a native
current-reader BFF boundary that refuses stale viewer/credential intent before a write. The existing boolean rating
adapter is insufficient for Search's explicit question identity/revision/scale binding; implement that guarded native seam
and supported own-score set/clear controls. Keep zero distinct from absence. Conditional providers must retain
atomic_guard_unavailable until native participants are ready; no unlocked preflight is acceptable. Entry and score writes
are independent. Collection, Review, Space and Account actions remain with their native owners. Do not edit release-search
or concept-browse modules.

Use the existing controlled page coordinator to bind viewer, credential, locale, page/request owner, registry, generation,
exposure admission, rowKey, original/resolved Subject, entry incarnation/revision and question revision/scale. Its registry
must persist across page incarnations to serialize competing native identities without queues or automatic resend. The
host's imperative observation must change or disappear immediately when authority changes. Suppressing displayed private
facts after a command must not erase the separate authority observation before the refresh settles. Known rejection
preserves only still-owned facts. Success or uncertainty retires private state, waits for already dispatched commands and
reads one authoritative complete current page. Reconcile duplicate occurrences together. `readDiscoveryMutationPage`
uses the existing page endpoint, passes cancellation and refuses automatic rating restart. No polling or retry loops.

Preserve URL query, kinds, filters, ordering, scroll and expanded context. Provide labeled keyboard controls with pending,
rejected, uncertain, successful and retired feedback, predictable focus after completion/cancellation, and a focus target
when a row disappears or the page restarts. Late writes and reads cannot repaint another viewer/query/locale or reopen a
retired form. Share/reload/Back use current server facts; cursors and mutation lifetimes remain transient. Distinguish
unknown, unsupported, concealed, signed-out and unavailable states in all eight locales; reuse native sign-in/return links.

Derive complete finite whole-page costs including the capability seam, admission, public/native/private reads, identities,
questions/exposure observations, final guards, serialization, one refresh, rejected/duplicate rows, empty pages and cleanup.
Retain ordered original {rowKey,subjectId} inputs, at most 100 identities and 16384 UTF-8 bytes, and 65536 private output
bytes. Use the installed retained cut and bounded page producer. Keep private evidence out of public summaries, OpenSearch,
public caches/keys and URLs. Add no continuation protocol, runtime funding or refill caps.

Extend `apps/web/tests/search-mixed-personal-actions.test.tsx` with live host/native-adapter coverage, score zero/clear,
profile restrictions, rejection versus uncertainty, duplicate reconciliation, credential/page/question retirement across
server awaits, overlapping commands, limits, empty/final pages and mounted keyboard/focus/scroll/URL preservation. Only add
stories for named states, preserve unchanged assertions, list changed existing assertions, and never edit frozen acceptance.

Before each check commit and after each fix commit again. After the last edit run changed tests once through
`bun run --cwd services/kernel check <workspace-relative files>` and/or
`bun apps/web/scripts/focused.ts --private-network -- bun test <workspace-relative files>` from the root. Type-check each
changed workspace from the root, preserving compiler-database/check-host placement. Wait for long sessions with
write_stdin yield_time_ms 300000. Do not run acceptance, root/worker/remote checks, browser/native suites or controller
gates. Broader acceptance remains deferred under the original task's launch policy.
