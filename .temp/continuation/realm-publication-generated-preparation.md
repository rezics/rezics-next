---
{
  "goal": "web",
  "manager": "web",
  "kind": "interface",
  "riskAreas": [
    "authorization",
    "disclosure",
    "rights",
    "account",
    "deletion"
  ],
  "criticalPath": false,
  "waiting": [],
  "paths": [
    "apps/web/src/community/realm-publication-preparation.ts",
    "apps/web/src/community/publication-controls-view.tsx",
    "apps/web/src/community/space-actions.ts",
    "apps/web/src/community/realm-publication-lifetime.md",
    "apps/web/tests/realm-publication*.test.ts*",
    "apps/web/tests/realm-publication-current-review.test.tsx",
    "docs/goals/web.md"
  ],
  "after": [
    "799c5935-7f82-4008-8d2a-49c6ea01d740",
    "2ad15f1a-b51c-45b7-9103-e8d6a5cbb5be",
    "b577f5d0-f5f3-4e5e-adc9-7ef12e6f077b",
    "33e23116-cfa8-4df3-8deb-e3946641fd7e",
    "3735feb6-779a-41c7-96f2-32b16cbf487c"
  ],
  "estimate": {
    "lines": 320,
    "files": 7
  },
  "acceptance": {
    "command": [
      "bun",
      "apps/web/scripts/focused.ts",
      "--private-network",
      "--",
      "bun",
      "test",
      "realm-publication-current-review.test.tsx"
    ],
    "tests": [
      "An explicitly selected work reads one installed generated native preparation and distinguishes no publication, adopted, rejected and withdrawn heads before explicit decisions.",
      "Populated and concealed optional presentation use the actual generated producer variants without retaining picker or former disclosure as native presentation.",
      "At 1/10/20 admitted detail fields projection is linear with fixed request components and byte limits derived from the installed producer.",
      "409/412 requires explicit reinspection then a separately confirmed fresh action; unknown writes retain the exact original command despite read-only inspection.",
      "Viewer/session/source/disclosure replacement retires the mounted category and late focus effects; commands reauthorize."
    ],
    "failing": true,
    "placement": "default"
  }
}
---

# Remaining outcome

After the installed KernelClient exposes the generated Realm publication preparation method and generated response
types, connect the existing selected review route to that method. Consume its producer-backed populated, empty,
concealed and unavailable presentation states and derive detail projection and serialized byte limits from that
installed producer. Add the named mounted review test for the generated path, including selected decisions, explicit
conflict reinspection, exact uncertain-command retry, and viewer/session/source/disclosure retirement.

Keep publication unavailable while the generated binding is absent. Do not add a raw request, local wire DTO,
hand-edited client declaration or second generator. The native/shared producer and controller own generation and
deferred native acceptance. Preserve the existing review state machine, credentials, locale, shelf reconciliation,
membership/Board consumers, bounded shelf reads and eight-locale copy.
