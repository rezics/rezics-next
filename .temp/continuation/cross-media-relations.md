---
{
  'goal': 'imports',
  'manager': 'imports',
  'kind': 'implementation',
  'model': 'gpt-6.1-sol',
  'effort': 'high',
  'paths':
    [
      'services/importer/src/cross-media-seed.ts',
      'scripts/datasets/cross-media-seed.ts',
      'packages/conversion/src/bangumi.ts',
      'packages/conversion/src/vndb.ts',
      'specs/cross-media-seed-api.test.ts',
      'docs/import-review.md',
    ],
  'riskAreas': [],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'acceptance':
    {
      'command': ['bun', 'test', 'specs/cross-media-seed-api.test.ts'],
      'placement': 'default',
      'tests':
        [
          "On a fresh dev stack the cross-media seed uses licensed real Bangumi and VNDB records for at least three franchises, idempotently, and each persona's API reads return work cross-media relations, character appearances across works and staff/voice credits; every unrepresentable relation names its exact source field in the result.",
        ],
      'failing': true,
    },
  'estimate': { 'lines': 1000, 'files': 10 },
}
---

# Read the complete cross-media graph after a real dump seed

Owner contract: [Cross-media dump seed](../../docs/import-review.md#cross-media-dump-seed).
The source seam is `services/importer/src/cross-media-seed.ts`, whose current result explicitly reports native
mapping gaps rather than presenting them as API graph readings. The existing registered converters emit work
metadata only. Do not manufacture a work/person equivalence from a matching title or name, or reinterpret VNDB
`vn_anime.aid` as a Bangumi ID. Adopt an explicit, cited provider identity-binding path and native relation mapping
with the owning Semantic surface before writing those relationships.

Make the same command elect complete family membership using the source relation contracts, import reference
work endpoints, characters, persons, releases and episodes through normal APIs, and expose adaptation, sequel,
side-story, appearances across works, staff and qualified voice credits through ordinary subject/page readings.
Retain every source relation and qualification, with exact-field gaps for genuinely unsupported native values.
Expand `chars.main`, `releases_supersedes.rid`, bundle components and relation reference endpoints; include other
owned relation tables and their endpoints rather than treating the current named-work frontier as completeness.
Ensure missing target records, source anomalies and any excluded fields remain explicit. Keep source licences
and citations separate from editorial selection and cover/prose permissions.

Pin licensed dump captures/digests and a small real-record selection for Steins;Gate, Clannad and Fate (or other
three cross-media franchises). Through an ordinary provisioned seed actor, run on a fresh stack and run again
with the same durable state. Read the results as an ordinary reader, the importing account and an editor with
independent acceptance/adoption permissions, including denial and unchanged selection behavior. Assert actual
API graph values and current permissions rather than private SQLite contents or fixture-computed graph DTOs.
Write the missing connected API outcome suite, retaining the current synthetic selector/idempotency edge tests.
