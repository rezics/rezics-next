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

Acceptance: `bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/search/released-imports.test.ts`.
The case queries `Example Volume` anonymously through real `POST /v1/subjects:search` and allows the existing
15-second worker convergence bound. Its `Released Book native receipt` output records actual release,
subject, candidate and batch receipt identities. Execution receipt pending verification.

Remaining integrating question: Search's caller still owns the mixed-kind, kind-condition, base/facet and
hidden/takedown final journey. This Book adds no invented classifications or counts for that journey.

## Import and find one pinned Book

- Touches: one supplied record, its exact source tuple/journal and native public commands, then existing bounded
  default query and point reads.
- Bound: fixed native corpus and current-run keys; one candidate page per actual proposed property and existing
  importer candidate bounds. No history, binding or corpus scan, effect/index seed, new query or counter.
- Growth check: reuses existing importer and Search bounds. This demo proves the connected native outcome and
  makes no new growth claim.
