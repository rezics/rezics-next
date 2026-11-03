---
goal: web
manager: web
kind: interface
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
  - deletion
criticalPath: false
waiting: []
paths:
  - apps/web/src/community/realm-publication-preparation.ts
  - apps/web/src/community/publication-controls-view.tsx
  - apps/web/src/community/space-actions.ts
  - apps/web/src/community/realm-publication-lifetime.md
  - apps/web/tests/realm-publication*.test.ts*
  - apps/web/tests/realm-publication-current-review.test.tsx
  - apps/web/src/stories/realm-publication*.stories.tsx
  - apps/web/messages/*.json
  - docs/goals/web.md
after:
  - 799c5935-7f82-4008-8d2a-49c6ea01d740
  - 2ad15f1a-b51c-45b7-9103-e8d6a5cbb5be
estimate:
  lines: 450
  files: 14
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - "--private-network"
    - "--"
    - bun
    - test
    - realm-publication-current-review.test.tsx
  placement: default
  tests:
    - "An explicitly selected work reads one installed generated native preparation and distinguishes no publication, adopted, rejected and withdrawn heads before explicit decisions."
    - Populated and concealed optional presentation use the actual generated producer variants without retaining picker or former disclosure as native presentation.
    - At 1/10/20 admitted detail fields projection is linear with fixed request components and byte limits derived from the installed producer.
    - 409/412 requires explicit reinspection then a separately confirmed fresh action; unknown writes retain the exact original command despite read-only inspection.
    - Viewer/session/source/disclosure replacement retires the mounted category and late focus effects; commands reauthorize.
  failing: true
---

Finish this after the native producer installs its actual preparation method and response examples in
`packages/client/src/kernel/community/routes.d.ts`. Until then, keep the named unavailable seam; do not edit generated
code or invent an endpoint or presentation DTO.

Once the generated response is available, connect the selected review port to it. Render its actual populated and
concealed optional presentation, derive detail-field projection and byte caps from that response, and add only the
named story states and missing mounted acceptance tests. Preserve existing explicit review, exact unknown retry,
shelf reconciliation, source/session retirement, departure and focus ownership. Native page, membership and Board
consumers remain outside this work.
