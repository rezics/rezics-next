---
goal: commerce
manager: commerce
kind: interface
paths:
  - apps/web/src/library/collection-metadata-history*
  - apps/web/src/library/collection-commands.ts
  - apps/web/tests/collection-metadata-history*
  - apps/web/src/stories/collection-metadata-history.stories.tsx
  - apps/web/messages/*.json
riskAreas:
  - authorization
  - disclosure
  - account
  - deletion
criticalPath: false
after:
  - e9314e51-a782-43e9-b55a-017dcc1bac53
waiting: []
estimate:
  lines: 650
  files: 11
acceptance:
  tests:
    - 'Installed generated history methods supply bounded private curator pages and two addressed revisions with truthful coverage and current allowed actions.'
    - 'Generated-client transport forwards authenticated session/current origin and handles response sessions, opaque cursors, original revisions/time and genuine authorization/session failures without exposing historical text or current Media in a public reader.'
    - 'Mounted Collection cases retire history on curator, account, session, locale and navigation changes while preserving metadata drafts and ordinary update/delete ownership; disclosed covers use the established media presentation without extra hydration.'
  failing: true
  workerOwned: true
---

# Connect the installed metadata-history transport

Finish the existing curator metadata-history reader through the installed KernelClient. Its published Collection declaration currently lacks metadata-history; both native routes are already mounted in services/kernel/src/library/collection-routes.ts. Use that source and services/kernel/src/library/collection-metadata-history.ts as complete publisher inputs. The native available cover includes its current disclosed summary. Consumer completion must not gate emission. Keep explicit unavailable until the publisher supplies the methods; do not generate or edit client declarations in this work.

Replace the unconditional unavailable handlers and hand-defined native response shapes with the actual emitted methods and response-derived types. Determine callable signatures from the installed declaration. Use existing Collection/session adapters for authenticated forwarding, current-origin checks, response sessions and private no-store handling. Preserve genuine failures and distinguish unavailable supplier, empty/unknown history, stale cursor and a retired selected revision. Keep revision >=2, UI limit 25, native limit 1..50, opaque cursor <=4096 and the native 128-change retention bound.

Retain the existing generation-bound page, selection and comparison retirement and first-page recovery during pending retries. Keep private history inside the currently admissible curator section and preserve drafts, editor return, ordinary update/delete commands and independent History stream recovery. Do not replace the structure-history shell or infer authority from displayed ownership. Reapply stays false.

Render an available historical cover through the established media presentation using only its returned current summary. None and withheld/unavailable remain separate and trigger no hydration. Preserve recorded values, paragraph text, time, visibility, presentation kind and before/after meanings.

Extend the focused metadata-history cases with actual generated-client transport and mounted Collection scenarios: two addressed revisions, original time/revision, opaque cursor recovery, session/authentication failure, account/session/curator/locale/navigation retirement, private-to-public transitions, and absent/unavailable/available historical Media. Keep the stable review story and existing eight-locale message workflow; add only strings needed by delivered states. Use existing native journal coverage instead of a growth suite.

Commit before checks and after fixes. Run changed-workspace typing and the focused Web landing command for changed tests. Native/database/browser/remote acceptance, DB-backed publication, original all-pool acceptance and the seeded running-product curator walkthrough remain controller work. Never count constructed component fixtures as seeded acceptance.
