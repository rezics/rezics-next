---
goal: web
manager: web
kind: implementation
paths:
  - apps/web/src/library/personal-list-import
  - apps/web/src/library/personal-list-import.md
  - apps/web/src/routes/library/import-vndb.tsx
  - apps/web/messages
  - apps/web/tests/personal-list-import.test.tsx
  - docs/goals/web.md
riskAreas: [authorization, disclosure, rights, account, deletion]
criticalPath: false
after:
  - 9a318a13-05cc-4091-b724-b19eeb5b0fc6
  - 52f6851a-a994-4d30-8d0f-8fcdd6d65ce5
  - 2bb1fbdd-fd3b-4f51-a945-0faf1a112617
  - d45a389d-5107-4ef0-b7ad-7cb2d75932f5
waiting: []
acceptance:
  command: [bun, apps/web/scripts/focused.ts, '--private-network', '--', bun, test, tests/personal-list-import.test.tsx]
  placement: default
  failing: true
  tests:
    - The installed generated client exposes typed VNDB score review, page and apply-result fields; Web sends only those generated requests and reports only native results.
    - One selected row can review vote units or clear against the actual question and current vote, with separate explicit consent and no automatic conversion.
    - State-only import leaves votes unchanged; source zero is invalid, native zero is valid, clear and absence remain distinct, and unsupported precision is preserved.
    - A changed question, identity, vote observation or review requires a new confirmation and command key; an unknown result retries the original selected score review and apply command exactly.
    - Partial cancellation preserves acknowledged state and vote outcomes, and retirement clears source, baseline, consent and late callbacks.
estimate:
  lines: 1300
  files: 10
---

# Finish typed VNDB score review and results in the existing import visit

Complete the VNDB score review when the installed `@rezics/client` publishes the typed score fields already defined by
the native owner. Its current installed declarations expose only the state choice, state page and state apply result;
do not hand edit generated declarations, cast the client, use a raw endpoint or add a second writer. Content's atomic
admission must also be published before any native vote effect can be enabled. Keep the source score and Library-state
import usable while those boundaries are unavailable.

Show each original VNDB score in its 1–10, 0.1 scale beside the actual native question meaning and selected units once
the generated page provides them. Never round, clamp, auto-select or describe 7.3 as exact on a native half-step
scale. Source 0 is invalid; native vote 0 is valid; a clear is separate from an absent vote. Notes, progress, privacy,
labels, dates, release records and unknown XML remain private evidence. Source privacy, upload consent and state
consent never authorize public or aggregate vote effects. Preserve an existing vote by default and explain precisely
which public and aggregate effects a successfully admitted choice will have.

Freeze the exact score review ID, upload/ordinal/target/question/revision/consent, apply body/key and credential visit
for unknown retries. New identity, question, current-vote observation or review requires fresh confirmation. Keep
native stale, refusal, unsupported and accepted results separate from state results in the existing results view;
partial cancellation preserves acknowledged effects. Retirement for account, CSRF, exposure, locale or source
replacement clears private context and prevents late callbacks from restoring it.

Exercise the published generated request boundary in the named test. Cover state-only imports, no implicit consent,
unsupported precision, explicit zero and clear, unavailable admission, changed review, lost acknowledgement with exact
retry, partial cancellation and retirement. Retain the 2 MiB XML and 12 MiB + 64 escaped wire limits, bounded native
pages/reviews/results and one selected row/intent. Derive added question, baseline, result bytes and fixed calls from
the actual owner contract. Keep all eight locales, 390px phone and 1280px desktop support, light/dark themes, wrapping
44px controls and keyboard review/confirm/retry/return behavior.
