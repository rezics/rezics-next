---
goal: commerce
manager: commerce
kind: implementation
paths:
  - apps/web/src/library/reading-insights-*
  - apps/web/src/library/library-nav.tsx
  - apps/web/src/routes/library/insights.tsx
  - apps/web/src/stories/library-reading-insights.stories.tsx
  - apps/web/tests/library-reading-insights*
  - apps/web/messages/*.json
  - docs/library-reading-insights.md
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
  - deletion
criticalPath: false
after:
  - 4eb20b39-4ee6-40ef-b769-f26028a87a62
  - 0be69cc6-322f-4765-be9b-dc4ebb98066b
  - a84bfd9a-34c8-472e-a867-559fb3be36db
waiting: []
acceptance:
  tests:
    - "Existing page journey keeps reported-year navigation, independent available/unavailable/failed panels, historical meaning, exact values and accessible table/chart counterparts; original Summary and Diary navigation remain intact."
    - "Existing page receiving cases: reported year, exact native values and meaning, independent panels and response-owned actions through the current owner/origin/locale visit; retired replies cannot hydrate another visit."
  failing: true
  workerOwned: true
estimate:
  lines: 2400
  files: 8
---

# Complete the retained private native-to-Insights journey

Retain this sole continuation handle and all dependency edges. The native overview and current-progress receiver are
integrated. Content owns the sole 445 publication of the matching official installed schema, callable client and root
exports for `library_reading_insights.overview` at `GET /v1/libraryReadingInsights`, including the current-progress
response schema. The installed `@rezics/client` lacks that publication. Wait for it before building the page; keep
transport unavailable. Do not add local wire DTOs, casts, raw fetches, generated/declaration edits, client overrides,
reflection, substitute reads or another generator. Publication remains independent of this receiver's completion.

## Remaining outcome

A reader opens private `/library/insights` through Library overflow, selects the reported year, understands exact
historical progress and assessment values, follows the existing Diary or Summary destination, and returns to the same
account visit without a retired response replacing current data. Complete only the missing reachable page and receiving
behavior against the official installed client. Preserve original Summary/month navigation, Diary-owned allocation,
native aggregates and maintenance authority. Do not change native commands or scheduling, or make GET schedule work.

Consume response-owned panels independently. A failed or unavailable panel must not erase successful panels or become
an empty observation. Display exact decimal/integer representations and returned units, dimensions, modes, accepting
meaning revisions, bounds and coverage. Never average incompatible meanings, reconstruct missing historical snapshots
from current profiles, convert exact values through JavaScript floating point, infer completion or recompute native
totals from local rows. Charts supplement accessible exact tables. Explain first-use, empty, historical-unavailable and
partial coverage truthfully, with locale strings for all user-facing copy.

Fence responses and response-owned actions by origin, owner/session, locale, resource, reported year, operation and
source generation. Retire pending work on visit changes. Keep selected, idle, loading, available, unavailable and failed
states distinct. Prevent concurrent duplicate requests while pending. Supported retry retains the exact year and
captured visit basis, intentional selection on recoverable failure, focus recovery and error descriptions. Use actual
official routes and current advice without inventing repair, rebuild or mutation permissions.

Preserve private account authorization, no-store behavior, current capability/exposure checks and exact closed controls.
Default-closed groups open only through documented local showcase persona/seed exposure commands; production defaults,
public account collections and unrelated Library surfaces retain their meaning. Reuse existing layouts and navigation
with phone and keyboard behavior.

Use only the two focused page/receiver groups in acceptance and stable existing story states needed to review actual
behavior. Changed tests/stories stay below useful product changes; avoid padding, restructuring and coverage-only
successors. Add missing focused cases only when the page/receiver can use the installed client. Preserve predecessor
acceptance and native growth/full-caller obligations. Native/database/browser/remote/root execution, focused landing
commands and final gates remain controller-owned; the supermanager owns seeded rendered acceptance. Source inspection
is not an executed pass. Broader acceptance remains deferred under the current controller launch policy.
