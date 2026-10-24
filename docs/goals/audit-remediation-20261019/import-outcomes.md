# Frozen import outcome specification

Both rows and all twelve persona cells remain **pending**. This is a test and
matrix contribution, not an implementation or proof. Registry enrollment belongs
to its separate author. No shared catalogue import, live capture or production
change is part of this contribution.

## Frozen scope and original identity

The [machine-readable matrix](../../../tests/qa/fixtures/catalogue/import-outcomes.json)
pins snapshot file SHA-256, logical snapshot digest, exact record keys and record
digests, original edge indexes and an ordered edge digest. Its inputs are retained
offline snapshots; no `latest`, prefix, `maxRecords`, discovery or network fallback
is allowed. A missing selected endpoint fails preparation. Record selection sorts
an exact set and gives the same result after input reordering. Original edge
indexes identify occurrences in the pinned snapshot, not native occurrence IDs.

Two named selections each contain exactly two providers:

| Selection | First source | Second source |
| --- | --- | --- |
| `fate-goldberg-v1` | VNDB `dataset-904aa4496a525e699074`, original `vndb:vn:v11` | MusicBrainz `dataset-a178e59cbd2efe477b79` |
| `index-goldberg-v1` | Bangumi `dataset-424753e973cbd3609613`, original `bangumi:subject:1014` | The same frozen MusicBrainz selection |

The MusicBrainz root is release group
`7c8f2d45-d764-347a-9ab9-0aa771a3447d`, The Goldberg Variations. Reusing it in the
second selection must reuse its source and native identities. These are isolated
command-created copies of retained evidence, never a reimport of the shared 113
Works. The fixture must retain the actual Work/Main Version bindings returned by
commands. A same-name substitute cannot replace those bindings.

| Elected surface | Exact retained scope | Required native positive |
| --- | --- | --- |
| v11 relations | All 50 outgoing `vn:*` edges, including unofficial `char`, `fan`, `preq`, `seq`, `ser`, `set`, `side` and official `fan`/`set` | Distinct typed native occurrences with exact endpoints, direction, type, official qualifier and the same inverse occurrence |
| v11 tags | All 10,106 raw `tag-vote` occurrences grouped by 211 exact source tag IDs | Explicitly accepted Date Display `g1005` classification and stable Concept/Sense identity; raw votes remain source-only |
| Bangumi | 24 subject relations, all 29 tags, 24 episode edges and the exact `staff:1` edge; 80 records including the retained failed lookup | Native relations/classifications and title, localized name, date, episode count and attributed synopsis; every elected edge has a disposition |
| MusicBrainz | Seven exact records, six elected edges; two releases, album, recording, composition and two artists | A genuine native release, ordered track occurrence, separate recording and composition, exact durations and independent artist-name supports |

The election does not claim whole-provider coverage. The matrix records the
excluded record count and exact selected set. Adjacent source records outside
that set, images and unrelated discographies are outside this test's import
scope. All fields of elected records remain available in the private retained
observation export; the 371 disposition rows are the explicitly elected fields,
edge occurrences and tag vote groups. They are not 371 independent user facts.

The accepted field-ownership matrix is copied without changing its decisions:
100 projected identity paths, 79 retain-C, 174 unobserved/empty, 17 context-B,
24 ordered-domain-B, 35 media-A, 1,584 relation-A, 205 release-A and 275 fact-A.
Its 2,493 zero-based structural indexes form a partition. The staged brief does
not supply `raw.fields` itself; this copy preserves the accepted rules and is not
a new verification of that evidence file. Source-zero, empty and uncollected
series references do not become counts of lost facts.

## Interfaces proposed for review

Existing source intake, conversion, source graph, proposal, native adoption,
field attachment, withdrawal, editorial control and native read commands remain
the owners. Access authority and rights evaluation are consumed. No alternate
adoption owner, provider-specific native Work class or import permission inferred
from Realm membership is proposed.

The tests introduce the following explicit interface obligations. They are pending
review and implementation, rather than assertions that these routes already exist.

1. `GET /v1/resources/{resource}/source-coverage` is a public, bounded read linked
   by `entity-page-v1.sourceCoverage.href`. Query: optional `actingSubject`,
   `limit` 1–20, opaque `cursor`. Answer profile: `resource-source-coverage-v1`,
   `items`, explicit nullable `nextCursor`, `sourcePosition`, opaque `generation`,
   `importState` and `contentReady`. Each item has a stable public field `key`,
   `state`, `native: [{resource, revision}]`, nullable public-safe
   `source: {provider, url, licence}`, and nullable `retry: {allowed, afterMs}`.
   Unknown entries have no source or retry detail. No observation/conversion IDs,
   raw pointers, hidden counts or acquisition internals are public. An inaccessible
   target and an absent target have the same 404 answer for every persona,
   including the operator's ordinary public read. Cursor pages use one cut and
   one generation; no first-N success or mixed replacement generation is allowed.
   A replaced cursor may instead return 409 `source_coverage_changed` with an
   explicit allowed retry of at most 300,000 ms; the test restarts at the new cut.
2. `GET /v1/sources/conversions/{conversion}/inventory` consumes existing
   `platform:catalogue-import` exposure and principal ownership. Query: `limit`
   1–20 and opaque `cursor`; answer has `items`, explicit nullable `nextCursor`
   and `sourcePosition`. An item contains `key`, `sourceKey`, `valueDigest`,
   `disposition`, nullable `reason`, `source: {provider, namespace, externalId,
   snapshotDigest, pointer, edgeIndex}`, and `native: [{resource, revision,
   sourceKind?, qualifiers?}]`. `pointer` is RFC 6901 within the pinned normalized
   `DatasetRecord.data`, not a false pointer into an HTTP response. For an edge,
   `pointer` is null and `edgeIndex` is its original pinned occurrence; a vote
   group uses its stable aggregate key and exact digest of all its retained votes.
   Each of the 371 elected keys occurs once. Adopted rows require positive native
   bindings; other rows require an explicit reason and no native binding. Reads
   of evidence belonging to another principal remain indistinguishable from 404.
3. The existing field-support attachment contract admits the existing native
   name owner through slot `component-property-v1#https://schema.org/name`.
   Target: the native Bach Agent; exact native name head is the CAS basis.
   Evidence A is the full artist record `/name`; evidence B is the release
   record `/artist-credit/0/artist/name`. Both retained references denote artist
   `24f1766e-9635-4d58-a4d4-9413f9f98a4c` and say Johann Sebastian Bach.
   The conversion grains are `artist`/`artist-credit`, fields `name`/`artist-name`.
   This is an adapter for a native slot, not a second support system. Two records
   yield distinct support bindings; another observation/request for one record
   does not. Independence here means separately withdrawable record support,
   not a claim that MusicBrainz mirrors are epistemically independent sources.
4. The existing resource parts read must expose a published release's ordered
   medium/track composition, through the existing Structure owner. It currently
   traverses Work compositions; admitting a genuine release target is a proposed
   extension, not permission to turn that release into a same-name Work. Its
   existing `parts`, `after`/`next`, role, order, label and target contracts are
   retained. Track occurrence `bf6c8e33-e330-3378-ae4a-32807b81a8d8` belongs to
   release `2ab08baa-b1c6-4aca-8cf7-c31565ef71b4`, medium 1, position 1, and
   points to recording `a6db9656-de18-4f60-93bf-386f22447199`. Its duration is
   `PT3079.093S`; the recording's distinct duration is `PT3078S`. A medium group
   owns the track occurrence, and native `schema:position` facts preserve both
   ordinals. The performed
   composition is `1d51e560-2a59-4e97-8943-13052b6adc03`.

Relation receipts bind each matrix edge to one exact native occurrence and a
published Definition revision, with `source` and `target` role bindings. Distinct
source relation kinds have distinct typed meanings; source official/order/type
qualifiers remain in the exact inventory binding. A generic related-card label
or `SourceDatasetRelation` description cannot satisfy this contract. Numeric
Bangumi roles remain exact qualified source roles; `staff:1` is not guessed to
mean director. Specific richer credit and contextual UI outcomes have separate
authors. This spec requires occurrence identity, type, direction, provenance,
continuation and inverse reads, not new UI presentation.

Positive native facts use `schema:inLanguage`, `schema:datePublished`,
`schema:numberOfEpisodes` and `schema:duration` through existing Statements.
Numbers remain exact typed values. MusicBrainz `text-representation.language=eng`
describes release text, while composition language `zxx` records no linguistic
content. Neither proves English audio. The 1982 DE release has retained Official
status and a native MusicBrainz identifier; it proves no complete playable
realization. The selected release with null source status must expose unknown,
not fabricated official or unofficial status.

Coverage states are distinct: `adopted`, `source-only`, `source-empty`,
`acquisition-failed`, `unmapped`, `pending-adoption`, `unknown`. MusicBrainz ISWC
`[]` is source-empty, its retained producer relation is explicitly unmapped,
and barcode is pending adoption. Bangumi `volumes: 0` is an unknown sentinel.
Bangumi `102461` has a retained official-API 404 with the archive identity still
intact; it is acquisition-failed, with a bounded retry, not a fabricated empty
character/summary list or deleted Work. Source activity remains source-only.
Completion of a descriptive import does not make content ready or verify all
fields. Private evidence without an independently public existence basis must
use unknown without source/count/retry disclosure.

## Fixture prerequisite and baseline execution

The subsequent [joint retained-record/native-support proposal](import-admission-contract.md)
specifies current and proposed request, refusal and receipt shapes. It extends
the existing Source and native owners, preserves the matrix's `.data` inventory
coordinates and adds a distinct full-record coordinate. Neither conversion nor
the Work scalar/type, Structure or proposed name slot admits arbitrary semantic
fields. Program reading and disposition remain required before implementation.

The tests deliberately have no fallback to the development stack, synthetic
same-name Works, invented provider responses, direct native SQL/RDF writes or a
missing-fixture skip. The producer has not been implemented here. A missing
`REZICS_IMPORT_OUTCOME_FIXTURE` fails the preparation hook and reaches **no
product assertion**.

G-2791 owns the single shared producer. Its exact import consumer, public-command
receipts and baseline compatibility requirements are in the
[import corpus handoff](import-corpus-handoff.md). Baseline and outcome execution
remain deferred until that producer and a compatible retained backup are ready
and the manager explicitly authorizes execution.

The prerequisite is a mode-0600 manifest matching `ImportCorpus` in the
[test support module](../../../tests/qa/support/import-outcomes.ts), under this
worktree's `.temp`. It must reference real retained input bytes, actual command
receipts and a `command-catalogue-backup-v1` manifest. Existing
`createCorpusBackupDriver` / `retainStoppedOwnerBackup` / `restoreCatalogueBackup`
can certify and restore the stopped-owner cut; do not create a second backup
mechanism. `REZICS_FIXTURE_ROOT` must be local, the restored QA run ID must differ
from the source build run, and it must match `REZICS_QA_RUN_ID`. No bearer is
retained: `restorePersonaRealms` signs in the retained Account identities normally.

The producer must:

- Build the selected corpus once using current public Main commands and actual
  receipts. Preserve every selected source record's exact payload, including
  existing chunked-intake framing when needed. The loader checks reconstructed
  payloads against pinned source records/API payloads. No placeholder successful
  observation or fabricated conversion row is accepted.
- Grant the fixture operator `platform:catalogue-import` exposure explicitly,
  independently of operator role, and use `grantFixtureAuthority` for necessary
  scoped owner actions. Record the grants/receipts. The Realm owner receives only
  the scoped editorial mandate needed to confirm the existing synopsis; stranger,
  member and moderator receive no import exposure. Sign-in, membership, ownership
  and moderation are exercised as negative import/adoption cases.
- Record truthful rights assessments and publication receipts before public
  reads. Bangumi subject synopsis keeps Bangumi attribution and CC BY-SA 3.0
  obligations. Covers, source user activity and unknown-rights text do not inherit
  that synopsis decision. Source ownership or a successful intake is not a
  licence. Private observation readback is an evidence export, not public reuse.
- Retain one consistent stopped copy of every owner store and media/object
  storage, with build, restore, startup and readiness timing. Preparation and
  isolated restore each remain within 600,000 ms. Every proof uses a fresh restore
  from the same backup; never rebuild for each persona or copy stores while live.
- Record successful native relation Definition/occurrence receipts, native release
  and track bindings when available, real per-record conversion receipts, both
  artist-name source references, and a principal-private canary observation.
  Missing proposed native results belong to test-body assertions on the baseline;
  never invent those receipts or require their success just to finish preparation.
  The backup's owner stores are the existing `postgres_data`, `fuseki_data` and
  `rustfs_data` volumes, including retained object storage.
  The canary is explicitly original fixture data, never represented as third-party
  captured source evidence. It cannot change public results or reveal evidence
  through the operator's ordinary public read.
- Retain distinct base/candidate conversion generations backed by real retained
  evidence or distinct mapping revisions over that evidence. Do not mutate source
  JSON to invent an update. Supply the existing public source-title application
  command and old/new public generation tokens. The test retains the old exact
  source graph, reads across replacement and checks idempotent replay, original
  identity and human-controlled synopsis after refresh. Human confirmation and
  one withdrawn name support must leave the other record support/native value.
  The restored synopsis starts source-managed. The owner confirms its exact
  value, then the operator retries that real source value with the pre-confirmation
  control basis: 409 `field_control_changed`, with human value and heads intact.

The original audit product baseline for future execution is
`69eac3ceeaf885be70205a70248bc951e9d81cc9`. The later nomination cannot replace
the original audit tree retained in state. This corrected pin has not been run.
Baseline execution must pin that product code and overlay only the independently
identified authored specification/test/support files, with the command-created
corpus restored into an isolated QA environment. The baseline manifest records
`phase: baseline`, that revision, `digest(matrix)` and measured preparation.
Record the fixed-wave revision, restored corpus generation and source snapshot
separately. A fixture unable to run the original product revision blocks proof;
it does not authorize a later product baseline.
Run each prove file serially against its own fresh restore. Pending cells use
`outcomeTest(..., undefined, { pending: 'assert' })` to report genuine assertion
failures without expected-failure inversion. A green runner exit is **not** proof.
Record the exact body title, first failed assertion and whether it was reached.
An authentication/setup/restore failure is a premise failure, never a confirmed
product defect. A candidate proof needs the same selection and backup, successful
outcome bodies, and later manager disposition before changing pending state.

No baseline API run is claimed by this specification. The exact outstanding
prerequisite is the command-created import corpus, stopped-owner backup and
restore manifest above. In particular, real multi-grain mapping inventories and
two refresh generations cannot be replaced with invented successful source data
to get past preparation. Until that prerequisite is available, the allowed
handoff is partial, with no failing product body and assertion reached = no.

## Prove files and persona mapping

| Prove file | Personas | Required result |
| --- | --- | --- |
| `tests/qa/integration/outcomes/catalogue/import-fidelity.test.ts` | visitor, stranger, member, owner, moderator, operator | Same frozen original identities and native facts, full typed/inverse relation pages, native classifications and real MusicBrainz grain; all non-operators denied import/adoption; explicit operator replays both selections |
| `tests/qa/integration/outcomes/catalogue/source-coverage.test.ts` | visitor, stranger, member, owner, moderator, operator | Same public-safe conservative coverage and positive native facts; owner confirms a same-value human decision; operator conserves/exports exact evidence, keeps principal privacy, attaches independent supports, withdraws one and refreshes atomically |
| `tests/qa/unit/import-outcome-contract.test.ts` | stack-free specification checks | Matrix partition and pending state; deterministic exact selection; rejects blanket source-only, empty native positives, dropped/extra/duplicate evidence, changed values and false native adoption |

The authorized later QA entry point is `bun scripts/goal/goalctl.ts test` with
the exact prove file, from its isolated restored environment. A recorded job
must use the main-checkout `goalctl.ts job` as the worker brief requires. No full
suite, browser server, new capture or shared-stack write is needed to build or
review these specifications. Spec commits stay on `wave/audit-20261019` until
combined proof and manager disposition.
