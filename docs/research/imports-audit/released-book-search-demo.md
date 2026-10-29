# Released Book native Search demo

`createDriverClient().init()` owns the searched world. The private
`client.importReleasedBook({ version: 1 })` imports and selects the pinned Book in that world,
then reopens the production importer's SQLite journal and replays the actual batch receipts.
It returns the native subject, selected candidate identities and original HTTP observations.
The importer and its owned temporary files are removed before the call settles and on close.

The integrating caller keeps this client alive for its remaining native requests:

```ts
const client = createDriverClient();
try {
  const driver = await client.init();
  const book = await client.importReleasedBook({ version: 1 });
  // book.subjectId and book.selected identify the actual imported, adopted Book.
  const response = await driver.request('anonymous', 'POST', '/v1/subjects:search', {
    text: 'Example Volume',
  });
  // Use the existing bounded worker-convergence wait before asserting visibility.
} finally {
  await client.close();
}
```

Input: `specs/fixtures/imports/wikidata/entity.json`, SHA-256
`6b1b348b9dbd5a4701495f00c041812742fbb8bf05eb0943218407b6a0674cbc`,
converter `wikidata-3`. Q571/revision 24681012 are synthetic fixture identities, not observed live Wikidata.
CC0 structured metadata supplies labels, aliases, description, names, date and URL; it supplies no summary,
media licence, word count, form binding or resolved author identity.

The separate scoped importer gets only create, batch-write, propose and fence-read permissions through
native registration and Global grant administration. The four existing personas and grants are unchanged.
Only retrieved, acknowledged source candidates are accepted and adopted; unresolved authors retain their
source identities and citations. No replacement editorial facts are proposed.
The caller lists and adopts each unresolved author's existing `sameAs` relation slot separately,
using the exact external IRI in the acknowledged proposal; a property-only candidate page does not list these slots.

Acceptance: `bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/search/released-imports.test.ts`.
The case queries `Example Volume` anonymously through real `POST /v1/subjects:search` and allows the existing
15-second worker convergence bound. Its `Released Book native receipt` output records actual release,
subject, candidate and batch receipt identities.

Verified revision: `f6e55d38436edddb9bf7e1002f95587b1871963d`.
The command above exited 0: one native case passed with 98 assertions, zero failures and no load reruns.
`bun scripts/worker-check.ts -- bun run typecheck` also exited 0 on that revision.
The active release was `sha256:eb8bc8b685e4f8e12897e0e9ac0ab978a8eff60102053081bd95ef4af0688702`;
the imported subject was `01a188dd-d299-75b0-b45d-1a1fea0415ac`.

All seven native command receipts returned 201 initially and replayed unchanged through HTTP 200 batches:

| Revision | Receipt key                                                                      | Native identity                                  |
| -------- | -------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1        | `wikidata:Q571:333c04dd151a2a6831c039cb9a651df29198be8a04e16ce861d4b6a34a11c954` | Subject `01a188dd-d299-75b0-b45d-1a1fea0415ac`   |
| 2        | `wikidata:Q571:a95d46234620a163ea524cf7adec1a0363bb33f9c6db355b5444a04d17a3fabe` | Candidate `1602da30-ba90-8a9c-97db-1a1fe9929a9b` |
| 3        | `wikidata:Q571:4319a6aa5ba45d128dc4c5b064fafe04e63cc72c9acf8b71fdfa632ac45103bf` | Candidate `d5b1e2e5-0a3a-81ff-af69-1a1f8f34e765` |
| 4        | `wikidata:Q571:c2adc44d0e6455a68f83d3a0083cbe64df5e09b00377095399f8526c66de04b0` | Candidate `99765726-9e0e-87d1-9ae9-1a1f4a70e151` |
| 5        | `wikidata:Q571:fd4caf639e3e218db502f5a497e6b132668243986136e2029bac9cf416d6979d` | Candidate `49c2977c-00ee-8358-903a-1a1f93697cd2` |
| 6        | `wikidata:Q571:d4872c8d28831c37b0c65cbacd9ec5f8542a2d00f484185241edea073ac0d1da` | Candidate `c9478797-acc0-83f1-81df-1a1f349f0542` |
| 7        | `wikidata:Q571:310f74ae9c48f6d96b3ab479e277940c5c99eb3ea92770168b5ecb444ccf6f49` | Candidate `6c269492-090d-8155-bd85-1a1fda3d2101` |

Anonymous alias search returned HTTP 200 with exactly that Book. Point reads matched the pinned labels,
aliases, description, selected names, URL, date and unresolved authors with citations; sentinel and absent-field
assertions passed. Reopening reported one unchanged record and no new batches; receipt replay left the point
read unchanged. This is native connected-outcome evidence on the tested revision, not a main-branch result.

Remaining integrating question: Search's caller still owns the mixed-kind, kind-condition, base/facet and
hidden/takedown final journey. This Book adds no invented classifications or counts for that journey.

## Import and find one pinned Book

- Touches: one supplied record, its exact source tuple/journal and native public commands, then existing bounded
  default query and point reads.
- Bound: fixed native corpus and current-run keys; one candidate page per actual proposed slot and existing
  importer candidate bounds. No history, binding or corpus scan, effect/index seed, new query or counter.
- Growth check: reuses existing importer and Search bounds. This demo proves the connected native outcome and
  makes no new growth claim.
