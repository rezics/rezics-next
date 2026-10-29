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
No composed page is claimed. Anonymous subject relation previews consume the existing
production semantic relay; no projection is seeded or marked ready.

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
heads. Assert anonymous subject output without a composed page. Inspection of
`semantic/subject.ts` and `link-freshness.ts` confirms that subject relation previews
also consume the link projection, so deliver real events with `linkProjection` before
those anonymous reads, reusing the existing native rich-field case's bounded drain. Keep CC0 at the source metadata seam.
Do not infer an author resolution port from an unknown identity. No helper, product,
definition, existing acceptance test or frozen file is edited.

Source-record metadata effect/read persistence, four-provider discovery, genuine
word-count/form/platform bindings and bootstrap-term fencing remain separate work.
This artifact accepts specification delivery only; a native failure is recorded as
such rather than rewritten into a product success claim.

## Verification

The native command was:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/wikidata-native-fields.test.ts
```

It exited **1, infrastructure failure**, after the wrapper's one automatic rerun.
Both attempts used the initial test revision
`4084f500b630af44af3e9fda91f93fbc887b807b`, with test SHA-256
`8f274a075a78b9a04830cebe581d410d8f24c8bfc22a4480cf9946a252f7187c`.
Neither log reported a test title, pass/fail count, assertion count or native
candidate/receipt result. There are **two defined cases**, with **execution counts
unavailable**, not two established assertion failures. The first attempt on host b
stopped growing after `stack-run: kernel check local, already on a check host`;
the automatic rerun on c stopped at the same line. The terminal error was:

```text
worker-check: infrastructure failure (log did not grow for 10 minutes) on ah-ipv6; second runner failed; log .temp/goal/checks/worker-check-2026-10-29T11-41-01.963Z-8c6e2e9b.log
```

Initial log: `.temp/goal/checks/worker-check-2026-10-29T11-21-22.544Z-5da97d91.log`.
The error is a tool blocker; there is no native pass or product failure claim.
No third native attempt was started after the automatic retry was exhausted.

Source inspection during the first checks identified the need to deliver actual
semantic relay events before anonymous subject relation reads. The final test adds
that existing production delivery and compares public values/ranks/qualifiers/references
as well as IDs. Property-ID matchers allow the native schema's additional datatype
annotation while retaining the exact expected ID and value. No timeout, configured
limit or required assertion was relaxed. The final test revision is
`63f110e6a637f7deb5533d8076860be23f4cf442`, with SHA-256
`654536a4c123d563ff739ac63925e6b71fd638d738e161d429d1fbc6054fbd00`. Its native execution remains unverified because of the tool blocker.

The root typecheck was restricted to the affected workspace:

```sh
bun scripts/worker-check.ts -- env TYPECHECK_CHANGED=services/kernel/test/imports/wikidata-native-fields.test.ts bun run typecheck
```

The initial version passed (exit 0, one of thirteen workspaces, kernel) after one
automatic infrastructure rerun. Its successful log is
`.temp/goal/checks/worker-check-2026-10-29T11-41-02.789Z-ea2bce06.log`.
The final test revision also passed (exit 0, one of thirteen workspaces, kernel).
Its log is `.temp/goal/checks/worker-check-2026-10-29T11-45-22.149Z-6f3d0456.log`.
The check waited for its shared slot, then completed; the remote cleanup warning
did not change the wrapper's terminal exit status.

The artifact acceptance command is:

```sh
bun scripts/worker-check.ts -- test -s docs/research/imports-audit/wikidata-native-fields.md
```

It is run after committing this final verification record. Its terminal result is
reported with the delivery; this nonempty-file check does not execute either native
case.

Only the two declared files changed; no outside-path files or existing/frozen tests
were edited. No full kernel, web or root gate, extra test suite, live provider fetch,
legacy port or growth check was run. The artifact's nonempty-file acceptance proves
specification delivery only; it cannot substitute for missing native execution.
