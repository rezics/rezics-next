# Synthetic Wikidata native fields and revision refresh

This freezes the source-specific native evidence gap in [the full source audit](wikidata.md).
The new suite is `services/kernel/test/imports/wikidata-native-fields.test.ts`.
The input is the explicitly **synthetic** `specs/fixtures/imports/wikidata/entity.json`:
Q571, native `lastrevid` 24681012, mapped Book type Q47461344. It is not an observed
live Q571 entity or revision. No new product mapping or definition is introduced.

## Cases and boundaries

Two independent native jobs have these exact titles:

1. `Wikidata synthetic native Book rich fields retain ranks qualifiers references and CC0 metadata through real editor selection`
2. `Wikidata synthetic native revision refresh preserves independent adoption history receipts and restart idempotence`

The first imports six actual source candidates: two names, two authors, a Gregorian
day and a URL. It checks preferred/normal source ranks, same-statement P1545 position,
the additional P854 URL, and the pinned entity citation in retrieved candidate bodies.
Both authors remain `somevalue` with their actual external identity and citation;
no Person subject or target UUID is supplied. Actual returned create/candidate results,
exact own-binding keys and persisted receipt identities tie observations to writes.
An authorized editor accepts and adopts retrieved IDs in Global before anonymous
subject assertions. Author slots are addressed by their exact external `sameAs`.
No composed page is claimed, and no projection is seeded or marked ready.

CC0-1.0 structured-data attribution is observed in the actual conversion capture,
not invented as per-fact rights or a licence for output. Commands remain facts only;
no summary, media or user prose is imported. Unknown-property, account and post
sentinels are excluded from command, captured conversion and public subject output.

The second changes P856 and the actual `lastrevid` to 24681013 in the same synthetic
record. It requires a stable returned subject, changed data digest, distinct command,
candidate and persisted receipt identities, and a citation pinned to the new revision.
An independent communal Context retains its previously selected old URL until its
editor accepts and adopts the new retrieved ID. The old candidate, source envelope,
revision history and receipt remain. Reopening the SQLite session and reimporting the
identical record must produce no bulk effects; replaying the actual refresh requests
must retain responses, receipts and native effect counts without a conflict.

The construction reuses `openApiRuntime` and `openApiObserver`: real Auth-issued
credentials, Access grants, ordinary dump reader, registration, Importer, public batch
handlers and editor APIs. SQLite uses the runtime's `os.tmpdir()` path. SQL is observation
only through the existing receipt/effect observer. Reads use a fixed known subject,
four property keys and two exact external author slots; each candidate/revision page
has limit 100 and must terminate with `next: null`. This fixed neighbourhood is not a
growth proof. Existing mass-loss, facts-fence, identity and unversioned suites remain
unchanged rather than being duplicated here.

## Source reading and decisions

Read the complete prior Wikidata audit, `packages/conversion/README.md` and
`packages/conversion/src/wikidata.ts`; the fixture and its README; existing pure
assertions in `specs/imports-wikidata.test.ts` and the structural
`packages/conversion/tests/wikidata-driver.ts`; the existing native unversioned,
known-reference and Open Library rich-field cases; API runtime, fixture and observer;
`services/importer/README.md`, reader, source registration and import contract;
and native editor schemas/slot addressing in `semantic/http/subjects.ts`, `item.ts`
and `candidates.ts`. Actual bundled definitions were read from
`packages/definitions/src/bundled.ts`, `catalogue/core.yaml`, `catalogue/book.yaml`
and `release/rezics.json`. They map P50/P1545/P577/P856 to
`schema:author`/`schema:position`/`schema:datePublished`/`schema:url`; labels produce
`schema:name`. The reference index was consulted; no external reference implementation
is required for this narrower existing mapping case, and none was copied.

Decisions: use URL as the changed accepted field, rather than immutable bootstrap
labels/aliases/descriptions. Use exact external author slots and retrieved editorial
heads. Assert anonymous subject output without a composed page, so no production relay
delivery is required for a page relation preview. Keep CC0 at the source metadata seam.
Do not infer an author resolution port from an unknown identity. No helper, product,
definition, existing acceptance test or frozen file is edited.

Source-record metadata effect/read persistence, four-provider discovery, genuine
word-count/form/platform bindings and bootstrap-term fencing remain separate work.
This artifact accepts specification delivery only; a native failure is recorded as
such rather than rewritten into a product success claim.

## Verification

Native execution and affected-scope typecheck are pending at the initial commit.
The test file hash, tested revision, counts and first failure or real pass will be
recorded after the prescribed single focused run. No full kernel, web or root gate
is part of this specification delivery.
