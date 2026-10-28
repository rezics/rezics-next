# Import to discovery acceptance

This delivers a specification under the fully read [API acceptance gap report](../api-acceptance-gaps.md),
including its released populations, exact sets, matrix and Imports section. The parent import-to-discovery
capability remains **incomplete**. File-presence acceptance establishes delivery of this document only.
No mappings, parser, release, query engine, routes or source metadata effect are implemented here.

## Actual dependencies and decisions

The admitted shared fixture is version **1**, export `createReleasedDiscoveryFixture({version:1})` in
`services/kernel/test/support/released-discovery.ts`, committed by
`f3d11d3f95fc5bbb4062f29c7e7b4b48b91afe60`. Its
[owning contract](../../../packages/definitions/src/released-discovery-fixtures.md) closes the interface.
This consumer uses `classification`, `books`, `read`, `request`, `meaning`, and `close` exactly as exported.
The builder owns native Auth/Access, reads and republishes the identical bundled release, and returns real
subject IDs plus candidate, acceptance-head, adoption-head, revision and release receipts. No consumer supplies
IDs, definitions, callbacks or additional fixture properties. Its link drain proves no Search readiness.
Missing released properties are native admission failures, never a substituted custom release.

The shared Book amounts are **controlled editorial assertions**, not imported counts. The builder explicitly
lacks same-statement holder/text/version/language/method/scope measurement evidence and a separate character
measurement producer. Those richer measurement cells cannot freeze yet. Detail assertions below prove only
selected quantities and unit `1`; they do not certify measured words. No provider input used here supplies words.
Edition pages remain pages. Recipe diet/cookTime controls belong to this same shared builder; there is no
four-source recipe-site ingestion or recipe adapter in this specification.

The actual scoped meaning is `wdt:P7937` for form, `schema:keywords` for tags and `schema:wordCount` for words.
`LN` and `HAREM` are the created Concept IDs, never Wikidata IDs, translations or source-label lookup results.
The source-scoped harem control is `(bangumi, meta_tags, 后宫)`, with a close correspondence; it is not proof
that a real converter resolves that binding.

The actual pinned Bangumi input exists: [public-book-meta-tags.json](../../../specs/fixtures/imports/bangumi/public-book-meta-tags.json)
and [provenance](../../../specs/fixtures/imports/bangumi/PUBLIC-METADATA.md). It is native Book 498, manga,
with the entire eight-member metadata-tag array including `后宫`; no revision was supplied by the source.
The archive SHA-256 is `9fe8de272398ff4bd12994b73e25aac37cca631372383f6aadc503528623aa93`;
member `subject.jsonlines`, physical line 457, raw-line SHA-256
`fb80ae3cb9b5a6713c4d8f105f0fcfa079963391c85f6aa15a00ebe9ddc5331e`.
This is an observed input, not an observed light novel or adopted harem fact. The converter currently ignores
`meta_tags`; its existence closes the input gap, not the resolved mapping/selected-fact gap.

All other inputs are explicitly controlled native-format fixtures: the existing Wikidata API JSON Lines,
Open Library work TSV plus a controlled edition, a bounded VNDB COPY archive (vn, vn_titles, entry_meta), and
one separate Bangumi ordinary-tag/novel/title negative control. Those native external keys are test source
records, not fabricated kernel identities. The importer supplies every kernel ID from actual receipts.
The negative Bangumi refresh retains the observed row so it does not trigger mass-disappearance policy.

`openApiRuntime` and `openApiObserver` supply the existing native readers, source registration, converters,
Importer, public batch transport, Auth-issued automated account bearer, real Access/grants, media workers and
public observation. Caps remain B=8, M=64, record bytes=65536 and the runtime collection limit=10000.
The editor creates a real community Context and accepts/adopts only candidates actually read from the importer.
The released group closes its fixture and the actual process-owned Semantic Auth host before Imports starts;
this uses the existing `closeOwnedSemanticAuth` export, not a replacement Auth service.
The consumer deliberately does not call the observer's `adopt` helper: that helper can author a replacement
candidate when no matching imported candidate exists. Anonymous reads name the actual selected Context.
These reads do not prove Global adoption, Global Search indexing or Context-to-Global publication.

The current runtime lacks `identifierLookup`. The Open Library edition therefore preserves an unresolved
`schema:exampleOfWork` candidate, separate `bf:Instance` identity and language; unsupported native `number_of_pages` stays unknown; no test injects
the work's returned ID. Fully resolved work/edition relations and VNDB release identities remain producer
obligations. Supported title/language/external-ID facts are selected and read, rather than merely checking
opaque normalized input. No supported form/platform/tag ingestion is claimed by those narrower passes.

For metadata attribution the authority is [Source record attribution](../../../services/kernel/src/semantic/source-record-attribution-contract.md):
`GET /v1/subjects/{id}` → `subject.sourceRecords`. Registration currently carries no general display metadata;
unknown metadata must read as `[]`, without alias-to-name/licence inference. The new test requires that actual
read shape after native import/editor selection. Positive attribution awaits Semantic's native metadata storage,
read projection and write operation, then Imports' distinct journalled current-run metadata step before bound/
unchanged shortcuts. No future writer/export is imported or called here. Facts rights are never used as metadata;
summary rights and cover credit remain separate under existing acceptance.

## Frozen native scenarios

The new native suite has **13 independent cases**, zero skips/todos and no missing-driver verifier.
These titles designate the acceptance bytes delivered here for manager freezing:

1. `catalogue words strictly over one million returns only B-long`
2. `catalogue released light-novel form AND harem returns exactly three books`
3. `catalogue conjunction of words and released form AND harem returns only B-long`
4. `catalogue harem facet counts only the exact selected three-book conjunction`
5. `readable Book detail retains selected word amounts and unit without edition page inference`
6. `readable Book detail projects actual adopted light-novel and source-scoped harem Concept IDs`
7. `bangumi ordinary importer candidates survive editor accept/adopt and anonymous selected read with citations`
8. `vndb ordinary importer candidates survive editor accept/adopt and anonymous selected read with citations`
9. `openlibrary ordinary importer candidates survive editor accept/adopt and anonymous selected read with citations`
10. `wikidata ordinary importer candidates survive editor accept/adopt and anonymous selected read with citations`
11. `Open Library edition keeps unsupported pages unknown and language separate from work identity and absent work words`
12. `Bangumi observed manga meta_tags and ordinary novel tags never imply light novel or imported words`
13. `imported selected metadata public read exposes sourceRecords without inventing unknown registration metadata`

Search uses the owning `POST /v1/subjects:search` schema: filter, sort `id`, limit 2, then opaque cursor.
Words use inclusive `gte:1000001` for strict integer >1000000. Exact sets over the shared population are:
words `{B-long}`; form AND harem `{B-long,B-edge,B-characters}`; conjunction `{B-long}`.
Controls include equality, short, absent, character-only logical control, tag-only, form-only and edition pages.
Full two-row pages or true exhaustion, exact order, no repeated cursor/ID and bounded complete traversal are
required. A 422 or 503 is a native red for the required ready job, not success. The facet test uses the actual
`facets:[{property,size}]` schema and requires the selected harem Concept with count 3 and an exact total.
Detail tests read factual projections; no filtering operation on a detail object is invented.

## Matrix still required

Every cell below remains applicable. Each distinct name is **NOT YET FROZEN**, not N/A, skipped or a passing
placeholder. They need extension of the one shared builder by its owner before a native request can be frozen.
The three catalogue jobs above are already independently named; this table names their other list consumers.

| Job                   | Public curated     | Everything WITHOUT state | Own state            | Mounted public Zone     | Configured Book TypeList |
| --------------------- | ------------------ | ------------------------ | -------------------- | ----------------------- | ------------------------ |
| words >1000000        | curated-words      | everything-words         | own-state-words      | mounted-zone-words      | type-list-words          |
| light novel AND harem | curated-form-harem | everything-form-harem    | own-state-form-harem | mounted-zone-form-harem | type-list-form-harem     |
| conjunction           | curated-combined   | everything-combined      | own-state-combined   | mounted-zone-combined   | type-list-combined       |

- **Commerce sources/personal/profiles:** the actual builder returns prerequisite descriptors, not Collection
  IDs or owner support producers. `collection-routes.ts` currently admits page/view parameters for members,
  not the report's proposed common filter/sort request. Commerce must supply its adopted query wire and actual
  public curated duplicates/notes/alias, Everything label-only and holding-only supports without entry/state,
  and selected own-state writes with accepted profile pins. Each expected set is the catalogue set intersected
  with the actual source/owner support union; Bob's facts never contribute. No guessed owner-query endpoint.
- **Semantic Zone sources:** `POST /v1/zones/{id}:readPage` and `GET /v1/zones/{id}/subjects` are actual owned
  boundaries. Retain their common-page and `{subjects,next}` DTOs respectively. The shared builder has no
  created public Zone, overlapping mount/saved scope or published dynamic generation. It must expose genuine
  producer receipts and native worker progress before these three cells freeze; a mount never grants source rights.
- **Semantic/Search configured TypeList:** the real boundary is the configured page read, not an invented
  TypeList endpoint or a direct matcher. The builder has no installed profile/template, route, TypeList
  configuration or native preparation composition. Owners must supply that configuration and its selected
  actual read before the three cells freeze. Canonical union/order, page completeness and current source
  authority must agree with catalogue semantics.
- **Semantic word measurements:** words-measured-statement, words-character-control and words-crossed-evidence
  remain NOT YET FROZEN pending the exact same-statement measurement grammar and genuine scoped editorial
  evidence. Do not present the current amount-only controls as fulfilling that evidence requirement.
- **Imports/Semantic mappings:** bangumi-meta-tags-selected-discovery, reviewed-form-selected-discovery,
  reviewed-platform-selected-discovery and four-provider-resolved-work-edition-release remain NOT YET FROZEN.
  Need actual reviewed source/property scopes, resolved bindings and released producer input. Neither ordinary
  Bangumi tags, title text nor `小说` creates harem or light-novel form. Unknown fields remain explicit unknown.
- **Semantic platform:** platform-release-same-statement and platform-false-Cartesian-control remain NOT YET
  FROZEN on Search, curated, Everything, own state, mounted Zone and detail/TypeList. The actual `platform`
  prerequisite says `schema:inLanguage` is a string and its qualifier grammar is unadopted. Require distinct
  real release statements (Switch/Japanese and PC/English/date) and reject the crossed combination. Work-level
  sets cannot supply release tuples. No invented platform payload, native Concept ID or credit-role-as-language.
- **Semantic/Imports sourceRecords:** selected-native-source-attribution-positive remains NOT YET FROZEN
  pending the producer described above. The unknown-array read case is not positive attribution evidence.

## Disclosure and existing acceptance

The shared `privacy` descriptor explicitly lacks the native withheld-tag, foreign fence/consent, hidden-original,
valid-suspended/delegated and repair producers. Required new composed names are query-withheld-harem-positive,
query-withheld-harem-NOT, query-withheld-order-count-cursor, mounted-withheld-original, query-foreign-source-fence,
query-withdrawn-consent and query-final-disclosure-revocation, independently on each applicable matrix surface.
They are NOT YET FROZEN until owner fixtures expose those real barriers. Reuse existing Search disclosure/cursor,
Semantic editorial/identity, Imports source-fence and Accounts durable-authority tests for their primitive cases.
No SQL effect/grant seed, permission override, locally signed token or fake projection readiness replaces them.

A valid suspended bearer requires 403 `account_suspended`; invalid/revoked credentials require their distinct 401
case. The builder's current `suspended` persona has a revoked pre-suspension credential and cannot prove the valid
case. Ban beats independent grants under the current adopted contract. Never silently mutate old frozen
expectations to reconcile these new cases. Withhold positive AND negative membership, ordering, counts, cursors
and public mount output immediately at final disclosure, even with the index paused. Useful full/exhausted results
or explicit retained preparation are required; an empty-success cursor chain is not acceptable. These requirements
remain open, rather than being credited to the narrow importer read cases above.

## Verification and cost

Run the focused native command exactly once after the final relevant test edit:

```sh
# Use the installed pinned runtime on the caller; stack-run selects the check host.
PATH="$PWD/node_modules/.bin:$PATH"
bun scripts/worker-check.ts -- bun scripts/stack-run.ts 'native discovery tmpfs evidence' . . -- sh -c '
  set -eu
  bun --revision
  env TMPDIR=/dev/shm bun -e '"'"'import { tmpdir } from "node:os"; import { statfsSync } from "node:fs"; const path = tmpdir(); const type = statfsSync(path).type; console.log({ tmpdir: path, filesystemType: type.toString(16) }); if (type !== 0x01021994) process.exit(1);'"'"'
  stat -f -c "selected filesystem: %T (%t)" /dev/shm
  exec env TMPDIR=/dev/shm bun run --cwd services/kernel check test/imports/discovery-user-cases.test.ts
'
bun scripts/worker-check.ts -- bun scripts/stack-run.ts 'discovery fixture root typecheck' . . -- env TYPECHECK_CHANGED=services/kernel/test/imports/discovery-user-cases-fixture.ts bun scripts/typecheck.ts
bun scripts/worker-check.ts -- test -s docs/research/imports-audit/discovery-user-cases.md
```

Historical evidence against base `c0c82dea99af6067464fafc403614d6acb43ebac` plus the original test/support bytes:
this run forced importer SQLite journals onto worktree `.temp/import-discovery` on Btrfs. It violates the
adopted tmpfs rule and is retained as environment-qualified history, not storage-correct native evidence.

- Test SHA-256: `98638edc178257c3e012a3ba7fd8d08def2ab4ec81041288801c95b0d8cb1362`.
- Support SHA-256: `c1e429a477868248b42d724ad639ef689950c91b6c91590ca5b9524ac839c382`.
- Final focused native run: **13 cases, 6 pass, 7 fail, 0 skips/todos**, exit 1; native log
  `.temp/goal/checks/worker-check-2026-10-28T18-29-18.213Z-affc4401.log`.
- First real failure: `Propose schema:wordCount ... expected HTTP 201, observed 400`, problem
  `invalid_request`, `effect_status:not_applied`, pointer `/statement/property/id`, code `unsupported`.
  All six released-book consumer cases encounter that actual missing bundled property before enumeration.
- All four importer/editor/anonymous-read journeys, separate edition identity/unknown-page control and
  Bangumi non-inference control pass. The seventh red is the real selected public read's missing
  `sourceRecords`: expected `[]`, received `undefined`. Its positive metadata producer remains absent.
- Final root typecheck: exit 0; log
  `.temp/goal/checks/worker-check-2026-10-28T18-35-49.703Z-bce10ddf.log`.

Earlier development runs exposed a fixture composition error: the shared Semantic Auth host outlived the
released fixture and collided with Imports' host. Native terminal disposal now separates those lifetimes.
The controlled edition also needed its required native `last_modified`; inspection confirmed pages have no
current converter mapping, so the final case explicitly requires honest absence rather than invented support.
No production or frozen-file change was made to obtain those historical results. They describe the original
support bytes, before the temporary-storage correction below. No full-kernel or root gate was run.
Red released admission is not native success.

Newest storage-correct invocation, 28 October 2026 UTC:

- Actual base revision: `2eb8bf31c4313bccc8ec27b92cf92a6e67d19c4e`; base tree:
  `248be733e294368217892f29ae054b9db261553b`. Tested tree after the fixture correction, before this
  evidence-only report update: `0139eaa74da6d09badf4bdc58f67484d9edf4d86`.
- Check host `a`, run directory `/srv/rezics-check/runs/mvsicotq-ee94cfd1`, runtime
  `1.4.4-canary.1+a0cc096ce` (pinned build `a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b`).
  The remote upload excludes Git metadata; the local tree above and remote SHA-256 output identify the bytes.
- Frozen test SHA-256 remains `98638edc178257c3e012a3ba7fd8d08def2ab4ec81041288801c95b0d8cb1362`;
  corrected support SHA-256: `ed34051ce1533484f82b2997bb2a3110058207a67164d9ede6bd34bfd5ca9267`.
- Host inherited `TMPDIR` was unset. The invocation explicitly selected `TMPDIR=/dev/shm`; the pinned
  runtime reported `os.tmpdir()=/dev/shm`, `statfs` type `0x1021994`, `tmpfs=true`, and `stat -f`
  reported `tmpfs (1021994)`. This is command-scoped environment selection, not a fixture mutation.
- Exactly one native focused run reached the suite after the final fixture edit: **13 named cases, 0 pass,
  13 fail, 0 skips/todos**, plus one unnamed teardown failure (Bun reports 14 failures total), exit 1.
  Log: `.temp/goal/checks/worker-check-2026-10-28T19-26-21.691Z-0029a0f9.log`.
- First real failure is now earlier shared setup: `Collection exposure setup failed: 403`, problem
  `forbidden`, `effect_status:not_applied`, at `test/semantic/outcome-driver.ts:365`, on
  `POST /v1/platform/exposure/collections:open`. The unchanged released fixture fails before enumeration.
  The frozen importer group awaits that same rejected released setup before calling `openDiscoveryImports`,
  so no importer SQLite journal was opened in this run. The selected filesystem is verified; journal I/O
  and importer outcomes are not newly demonstrated. No permission or lifecycle workaround was made.
- Missing bundled word data and the historical missing `sourceRecords` remain unresolved reds; neither
  assertion was reached in the newest run. Registered owner-query and released-library dependencies are not
  consumed or guessed here. No broader matrix cell is credited as delivered.
- One earlier wrapper attempt failed before the native command because its shell prelude was placed in
  excluded `.temp`: `sh: 0: cannot open .temp/import-discovery-evidence/native.sh: No such file`.
  Log: `.temp/goal/checks/worker-check-2026-10-28T19-23-25.565Z-ee5ae61c.log`. Passing that same prelude
  inline through the normal placement layer corrected the invocation; the suite itself was not retried.
- Root typecheck was selected only for the touched fixture with `TYPECHECK_CHANGED` as shown above:
  **exit 0**, one affected workspace (`@rezics/kernel`) on host `c`; log
  `.temp/goal/checks/worker-check-2026-10-28T19-25-26.579Z-9bbce6e7.log`.

The fixture now delegates directory creation and cleanup exclusively to `openApiRuntime`'s existing
`mkdtemp(tmpdir())`. No global environment mutation, second state directory, fixture factory, regression test,
product change or frozen acceptance change was introduced. The thirteen titles and assertions remain intact.
The setup failure precedes the corrected function; it is evidence about the inherited shared setup, not a
failure caused by changing the journal path. Permission changes are outside this correction.

Construction touches one shared bounded released population and one existing native importer runtime; all IDs
come from real APIs. Search traverses at most eight two-row pages for seven controlled Books; the underlying
production source/plan/page caps remain unchanged. Temporary importer journals use the runtime-owned directory
on the invocation's tmpfs (`/dev/shm` in the newest check); check logs remain under worktree `.temp/goal/checks`.
No production query, whole-library scan, client-created large ID vector, alternate preparation engine or cost
observer is added. Timing/helper counts do not prove native growth; Performance owns composed-cost acceptance.

Original reference reading was limited to the read-only `.reference/INDEX.md` and Bangumi server revision
`1997713eafc51487cbea705b37011442f35539fa`: `openapi/components/subject_v0.yaml`,
`internal/model/subject_type.go`, and `cmd/archive/main.go` metadata-tag serialization. These confirm the input
surface already documented in the pinned provenance; no reference code was copied, built or run. Owning
Definitions/catalogue, Filter grammar, Source record attribution, Semantic identity, filtered lists, Collection,
dynamic Collection, Collection source and Zone/page contracts were inspected. No topic was moved from the
external discussion repository, and no outside-path file or existing/frozen acceptance was edited.
The storage correction required no additional external reference reading; it follows the existing runtime's
temporary-directory ownership and the check-host placement and pinned-runtime runbooks.
