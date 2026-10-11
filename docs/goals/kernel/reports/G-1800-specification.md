# Imported covers: source evidence, copyright mark and scoped takedown

Read-only specification, 2026-10-11, against
`902d8eac6afac082532e8b0f789b2ea36bedd9f9`. All paths and current line anchors
refer to this worktree. Find the named function after preceding slices move
lines. Only this report was written. No product test, acquisition, upload,
native build or running service was executed; existing assertions below were
read, not proved green in this session.

The adopted outcome is [decision 55](../../../product/decisions.md#decision-55)
and [the source lifecycle contract](../../../contracts/source-lifecycle.md#platform-imports-and-user-contributions),
lines 24–49: retain and import covers, show `(c) rights holder via <source>`
with a source-page link, name a holder only when evidenced, claim no CC BY-SA
licence for the artwork, use it only as a cover, and take it down on an
authorized rights decision without taking down the Work's independent facts.
This specifies the missing connections, not another rights or media system.

## Current evidence and owner boundaries

| Stage | Existing code and tests | Missing connection |
| --- | --- | --- |
| Bangumi source record | `scripts/datasets/bangumi.ts:212–242` separates user-post exclusions from recursive image exclusions; `:347–387` captures exact API JSON but strips images; `:479/:781` return empty images. `:270–276` supplies subject/character evidence URLs. `tests/qa/unit/dataset-bangumi.test.ts:398,421–455` explicitly freezes the old image omission. | Extract a subject cover before stripping arbitrary nested image fields; preserve the exclusions for user posts, portraits and unrelated art. A Statement's evidence URL is not a cover mark. |
| Pinned image bytes | `scripts/datasets/types.ts:32–50` has image record/role/URL and capture availability; `snapshot.ts:8–33,68–98,150–166` hashes capture identity, freezes raster bytes, distinguishes 404/temporary failure, and verifies blobs. `network.ts:45–64,72–120` verifies cached bytes. | Bind the descriptor to the exact record evidence, optional evidenced holder and source link. Existing `snapshot.ts:79` prefix matching is not cover-role admission. |
| Import | `scripts/datasets/import.ts:408–413,707–714` retains image metadata in JSON evidence. `:483–545` checkpoints immutable API requests, uses source intake and its returned identities. `source/intake.ts:9–21` already accepts provider strings. | No binary upload, cover selection, copyright mark or cover-specific refresh fence is invoked by the dataset importer. Intake JSON is bounded to 64 KiB; it cannot carry raster bytes. |
| Media custody | `services/main/src/modules/media/README.md:3–20`; `media/store.ts:256–266,467–499` uses a Content asset revision manifest and immutable object namespace. `media/commands.ts:139–205` verifies reservation/principal, digest, length and image format, quarantine read-back, settlement and resumable revision creation. `tests/qa/integration/media-api.test.ts:9` exercises this owner. | No imported-cover provenance/mark in the manifest, upload or media schema. Keep bytes in this owner, not in a graph Statement. |
| Cover selection | `media/store.ts:600–666` implements avatar slot CAS, exact asset revision/Representation/Use, explicit removal, stale receipts and replay. `media/typed-schema.ts:102–147` has avatar/document/publication/showcase roles. `docs/contracts/media.md:84–91` explicitly says CoverSet/BannerSet APIs are pending. Studio currently calls avatar selection (`apps/web/features/studio/cover-api.ts:5–10,50–57`). | Launch must supply the admitted cover-selection contract and its relationship to the current Work avatar slot. This report does not silently choose avatar as the permanent CoverSet API. |
| Rights and credits | `rights/schema.ts:10–21,23–74` owns material/use assessments and obligations. `rights/store.ts:92–125,417–490` projects current wiki-display obligations. Work author credits (`work/author-credit.ts:13–58`) name authors, not artwork holders; image Works and their eventual credit index are separate (`docs/contracts/media.md:42–54,71–73`). | A cover's copyright/source evidence is neither a Work author credit nor the Work text's licence. Current display obligations lack a structured cover source link. Do not promote cover Assets to image Works to get credits. |
| Rights notice | `routes/rights.ts:206–245` uses `GovernanceStore.submitReport/decide`. `governance/evidence.ts:230–277` can capture exact media Use and source cover evidence. `governance/schema.ts:9–25` already admits source/media, cover/media_use, source_apply/search/media_delivery/export. | Exact source cover evidence and exact media evidence are not linked. Source-owner effects currently return an Access fence receipt only (`governance/effects.ts:198–199`). |
| Restriction | `rights/store.ts:210–257` follows source/native synopsis restrictions; `governance/effects.ts:95–121,164–199` resolves media evidence and calls `MediaStore.moderateOriginal`; `media/store.ts:824–918` reconciles receipts and suppresses the original/Asset. | No cover counterpart for source refresh or source-to-media effects. Copyright decisions must not automatically use the NCII-only global digest closure at `governance/effects.ts:122–137,177–184`. Suppression is Asset-wide at `media/store.ts:900–914`; an exact older revision is not authority to suppress an unrelated replacement. |
| Pending restriction | `governance/store.ts:1159–1185` applies owner effects and returns pending on continuation; only `:1187–1218` writes the enforcement fence. | A new multi-page source effect cannot assume its Access fence protects reads during pending work. G-1803/Trust-ops must approve and qualify the transition ordering before slice 7. |
| Derived images and bytes | `services/content/migrations/760_media_width_renditions.sql:17–25` derives clearance from the exact original. `media-rendition/store.ts:60–89,224–240,314–352,390–413` gates candidate reads, work and settlement. `routes/media.ts:194–201,357–383,531–586` rechecks eligibility before bytes/304. `tests/qa/integration/media-rendition.test.ts:410–443` covers retained rendition URLs after suppression. | Consume source-cover restriction at these existing seams; never add another thumbnail worker or direct public object URL. |
| Cards and search | `media/summary.ts:243–249,729–761` supplies images and final Asset disclosure. `discovery/read.ts:75–78,127` uses live summaries. `search/result-cards.ts:207–226` rehydrates cover from `current.avatar`; `search/card-reads.ts:36` retains live media checks. Quick search uses live avatar at `routes/search.ts:262,293–302`. | Carry the mark with the image descriptor. A cover takedown removes the image/mark from results while the Work can still match independent facts; no new search projection is needed. |
| Web | `apps/web/features/catalogue/cover.tsx:5–17` is shared across catalogue surfaces. `catalogue/work.ts:56–59` reduces the descriptor to image props. `api/media-metadata.ts:25–44` and `packages/ui/src/components/media-image.tsx:27–36` drop any cover attribution today. `rights-mark/rights-mark.tsx:6–9,60–84` renders existing fact/text duties. | Preserve structured cover credit and render it beside the actual image. Reuse the rights-mark feature without parsing a licence notice into cover provenance. |
| Role leak | `apps/web/features/showcase/slide.tsx:39–52` preloads a cover as fallback background; `:194–202` renders its decorative ambient copy. | Imported cover-only art cannot supply these showcase/background paths. A framed identifying cover and independent showcase art require Launch's explicit interpretation of the role contract. |

In this table, `media/`, `rights/`, `source/`, `governance/`, `discovery/` and
`search/` expand under `services/main/src/modules/`; `routes/` expands under
`services/main/src/`. Bare dataset filenames expand under `scripts/datasets/`;
`catalogue/` and `rights-mark/` expand under `apps/web/features/`. All later
slices use the same notation.

## Target producer-to-consumer contract

### Identities and storage

Recommend extending the existing **media asset revision manifest** with optional
imported-cover provenance, with an indexed Media-owned projection for exact
reads and case closure. Launch/Trust-ops review this representation in slice 3.
The projection is derived evidence, not another assessment, source registry or
restriction decision. Existing non-imported media keeps its existing shape.

The normalized candidate needs: provider, namespace, external record ID,
source revision and exact captured record digest/field locator, source display
name and canonical record-page link, image capture URL/digest/length/MIME,
and nullable holder name plus its evidence locator. A source revision may be
unknown; do not manufacture one from fetch time. The dataset snapshot digest
and the captured record digest have different meanings and stay separate.
Bangumi's subject URL follows the elected returned/redirected subject identity,
not an unverified requested ID. Neither a studio/publisher fact nor an uploader
name is evidence that it owns the cover copyright.

After source intake, the media command binds the candidate to the returned
native source record and exact observation, its retained digest, and the exact
original Representation/image digest. The resulting asset revision and Use pin
that provenance. Use a small, explicitly scoped normalized cover-evidence
observation through the existing intake, under the canonical provider/namespace/
external ID (the same record identity), with its own idempotency key. Its body
contains the frozen descriptor and capture references; refuse a descriptor above
the existing 64 KiB ceiling. It is not another source record registry.
This avoids reconstructing the entire large record at media admission:
`scripts/datasets/import.ts:45–92,518–545` otherwise chunks it into distinct `*-dataset-part`
records and returns several observations. The cover evidence observation does
not claim complete coverage of the original subject JSON.

`SourceIntakeStore.read` (`source/intake.ts:285–290`) verifies retained bytes
and principal; extend that owner with the bounded typed descriptor verification
needed here. Verify canonical identity, descriptor fields/locator, retained
normalized-envelope digest and declared image digest, not just a client-supplied
record/observation pair. Keep the original API/dump capture digest as a separate
provenance reference: the server retained a derived envelope, not that full
provider response. The dataset verifier checks the referenced original capture
locally before submission. This proves integrity and the operator's attributable
mapping, not independent remote authenticity or copyright ownership. If required
evidence is not retained/verified, report the binding unavailable.

Store source and holder facts once in the revision; **derive** the public mark
text and structured link from them. Do not persist independent editable mark
strings on every thumbnail. Proposed public field, finalized by Launch:

```ts
coverCredit: null | {
  kind: 'copyright';
  text: string; // "(c) rights holder via Bangumi", or an evidenced holder name
  holder: string | null;
  source: { name: string; href: string };
  permittedRole: 'cover';
}
```

An imported cover requires a credit. `null` means ordinary non-imported media
has no such import credit; it does not mean a restricted imported image remains
available without its mark. An unavailable/fallback descriptor carries no
credit, source link, asset identity or hidden reason. No cover field reports
`CC BY-SA`, share-alike or an invented legal licence. Fact/text obligation reads
remain independent. Actual legal assessments and obligations continue through
`RightsStore`, including unknown/undetermined bases; a copyright mark does not
turn them into supported permissions or make the importer an assessor.

Source observation JSON and raster captures stay in the dataset's existing
content-addressed store for reproducibility. Served originals and derived images
stay in Media's `media/asset/<asset>/` namespace, with upload quarantine in
`media-quarantine/<upload>/`, Content revision custody and existing receipts.
Dataset blobs are not public delivery URLs or an alternative production media
owner. Future tests must override the dataset root into the worker's `.temp`;
`scripts/datasets/store.ts:11–18` otherwise defaults to a shared sibling store.

### Operation sequence and failure semantics

1. Capture record evidence and elected cover bytes; freeze/hash/verify the
   normalized descriptor. No live image refetch during import or replay.
2. Import the record's facts through the existing API/journal, retaining source
   evidence and returned record/observation/Work identities.
3. Reserve the media upload with verified imported-cover intent and source
   evidence already bound. Transfer pinned bytes; replay reserve, transfer and
   asset revision creation using existing receipts. Do not create a publicly
   reusable unmarked image and attach provenance in an unrelated later step.
4. Select the exact asset revision/Representation through Launch's cover
   command, with its observed selection head and idempotency key. Removal,
   context and ratio semantics belong to that command. A conflicting writer
   gets stale/conflict; importer replay must not silently rebase over an editor's
   cover. Upload success and selected/servable cover are distinct outcomes.
5. Readers obtain cover plus credit together through the existing bounded
   summary/metadata path; thumbnails resolve their credit from their exact
   original and Use. Byte routes recheck current access, source restrictions,
   lifecycle, selection, clearance and erasure before delivery or 304.

Keep activated-but-screening/held, rejected, missing capture, temporarily
unavailable capture, stale selection, denied, source-restricted and owner
unavailable outcomes distinct. A cover failure must not roll back or falsely
mark failed the successful import of independent Work facts. Reuse import
checkpoints to retry the unfinished image step; do not create a second job or
receipt ledger. An unavailable rights/source owner cannot mean “no fence.”
Capture and admission budgets also differ: snapshot capture allows 16 MiB
(`scripts/datasets/snapshot.ts:83`), Media upload allows 8 MiB, and the current avatar policy
uses 2048 pixels/4 MiB (`media/store.ts:31–33`). Consume Launch's cover policy,
report oversized/unsupported imports explicitly, and use existing derived-image
processing where admitted; never substitute a silently fetched or rewritten
original to make a capture fit.

Persist a cover-only invariant for imported assets, not just the first Use's
role. Every revision upload/replacement of that Asset preserves the invariant;
every selection/publication/document/showcase/campaign admission checks it.
Only Launch's admitted identifying cover role can use those bytes. Generic
Agent avatars, body attachments, publication items, banner and showcase art
cannot launder them into a new role. Do not apply this restriction to all
ordinary user uploads: decision 55 distinguishes user contributions.

Screening is unchanged: binary validity, configured required matching,
known-copy suppression, disclosure, NSFW/age presentation and legal evidence
are separate checks. `media-screen/required-matcher.ts:10–26` defaults to
`none` and leaves provider matching unavailable until its approved adapter;
cover import must neither bypass configured matching nor add a mandatory NSFW
classifier or new provider integration as an implicit cover prerequisite.

### Notice, takedown, reads and recovery

The existing notice/counter-notice flow is being specified by **G-1803**. Consume
its approved scope, admission, decision and restoration contract. This report
adds the cover-to-source/media bridge only. A notice alone is not a new automatic
decision; an authorized interim or final restriction must reach both sides:

- Access governance enforcement fences the covered source component before
  refresh/reapply can install another image. Proposed record-wide `cover` scope
  prevents a changed observation, URL or digest from evading a cover decision;
  Trust-ops must approve that scope. An exact-observation decision remains exact
  when that is the scope actually authorized.
- Existing source-to-media provenance identifies retained originals/Uses in a
  bounded indexed keyset. Existing governance effect continuation/receipts apply
  Media suppression to the authorized closure. Never scan the full catalogue,
  report success after the first batch, or invent global digest suppression for
  ordinary copyright complaints. If the decision covers known affected copies,
  use its approved identity/closure rules.
- With the owner-approved fence-before-fanout transition in place, read-time
  source-fence checks block linked bytes while owner effects are pending.
  **That ordering is not current behavior:** GovernanceStore presently writes
  enforcement after effects complete. G-1803/Trust-ops must provide either the
  approved earlier fence transition or an equivalent existing-owner protected
  transition and its pending-first-page proof before this guarantee is claimed.
  Subsequent summary/search, original/thumbnail, selected
  URL, direct Representation and exact Use reads cannot escape by choosing a
  different endpoint, Use, signed-in viewer or old ETag. An in-flight transform
  rechecks before settlement. Use existing admission freshness/recovery rules;
  do not invent a second cross-owner authority epoch.
- Work identity, titles, credits, summaries and independently supported facts
  survive a cover-only decision. Search continues returning the Work with its
  normal fallback, and emits neither the hidden cover's source mark nor its URL.
- Counter-notice, appeal receipt, human confirmation, refresh, import retry and
  backup replay do not lift a restriction. Only G-1803's authorized attributable
  restoration may do so. An independently replaced native cover is considered
  under its own provenance; it cannot clear the source fence.

“Take down” currently means suppress delivery and retain authorized evidence;
physical erasure is a separate Trust-ops decision and existing erasure operation.
Never delete objects directly from the complaint handler, discard preservation
holds or infer media.manage authority from attachment ownership. Where erasure
is explicitly admitted, consume the active Trust-ops asset revision/original/
derived/quarantine closure and recovery journal; retained dataset evidence also
needs its own owner/retention decision before anyone promises physical deletion
of every copy. This report does not add an erasure implementation.

The existing `public, no-cache` response requires validation before reuse, per
[RFC 9111 §5.2.2.4](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.4)
(checked 2026-10-11). That supports rechecking old delivery URLs; it does not
prove that web/CDN caches implement the policy or retract bytes already received.
Private/draft deliveries retain `private, no-store`. No cache purge service or
new freshness policy is needed for this specification.

## Acceptance and dispatch rules

**A** means a first-public-scope function is incomplete without the slice;
**B** means a working function or permission-gated scope can defer it;
**C** means defer/cut. Imported identifying covers are explicitly in the first
public scope, so the required connection slices below are A. They are bounded
Luna/max sessions, not an instruction to implement the whole report at once.

The brief supplies no cover acceptance IDs. The following are **local acceptance
labels for dispatch**, not entries silently added to the QA registry. Program
must assign/register their owning proofs under existing cases or new IDs before
claiming acceptance green. Existing contributions: `GOV24/GOV25`, `LIVE13/16/17`,
`VIEW07/08`. `LIVE18` currently names a synopsis (`source-conformance.ts:125–129`);
Program must explicitly extend its scope if it wants to count cover refresh.
Passing cover tests alone never makes all contributors to these broad IDs green.

| Local acceptance label | Required outcome |
| --- | --- |
| COVER-PIN | Elected cover/source/holder evidence and exact bytes are immutable and replayable; excluded user material stays excluded. |
| COVER-CONFIG | A second normalized source adds only reviewed configuration/fixtures; generic cover capture/import/Main/media code is unchanged. |
| COVER-BIND | Exact observation, asset revision, original digest and cover Use are owner-verified; retries preserve identity. |
| COVER-ROLE | Imported bytes cannot become avatar/body/publication/banner/showcase art; cover removal/replacement uses normal CAS. |
| COVER-MARK | Every available imported cover descriptor/render has the copyright text and source link, no inferred holder/licence. |
| COVER-FENCE | Authorized source-cover restriction blocks new installation and all existing original/derived delivery, leaving Work facts. |
| COVER-EFFECT | Full authorized source-to-media closure settles through bounded continuations and replay-safe owner effects. |
| COVER-IMPORT | API-only dataset import resumes partial upload/select outcomes without duplicate effects or editor overwrite. |
| COVER-RECOVER | Restriction survives replay/restore; only authorized restoration can lift it; erasure never resurrects bytes. |

Mechanisms use the actual inventory at `scripts/static/mechanisms.ts:23–40,60–81`:
`rights-evaluation`, `governance-restriction`, `access-authority`. Media/Source
custody are existing owners, not new inventory IDs. Pure dataset/render adapters
declare `Mechanisms: none`; slices touching assessment, enforcement or authority
declare consume/extend as below. No proposed second registry or compatibility
layer is permitted.

Every implementation worker runs only its listed files through
`bun scripts/goal/goalctl.ts test <files>` and records its QA run ID. Route
changes also require `task gen`, `task main:typecheck`, `task web:typecheck` and
restoration of generated outputs before handoff; dataset changes use
`task dataset:typecheck`; web uses `task web:typecheck`. Run changed-directory
lint/code-shape checks under the worker protocol. Manager runs affected tests
outside each claim. The **specification** brief overrides documentation QA here:
no product tests or documentation suite were requested for this report.

## Ordered one-session slices

Estimates include focused checks and commit, not measured Luna timing. The eleven
sessions total approximately **9 h 25 min**, leaving 35 min inside the ten-hour
window. This is conditional on Launch's selection seam, G-1803 decisions and
provider mapping seam being available before dependent dispatch; waiting for
another Goal cannot honestly be counted as completed implementation. Stop and
resize a slice before dispatch if rebased owner code makes it exceed one session.

### 1. Normalized source cover and Bangumi extraction — A, 35 min

Files/current anchors: `scripts/datasets/types.ts:32–50`;
`scripts/datasets/bangumi.ts:212–267,347–387,479,781`;
`tests/qa/unit/dataset-bangumi.test.ts:278,398,421–455`.
Define the provider-neutral candidate described above. Extract only the elected
subject-cover field from captured JSON before recursive omission; return the
candidate instead of empty images. Keep arbitrary nested images, portraits,
screenshots and user posts excluded from native fact mapping. Preserve all
record values and disclose cover-specific capture limitations. Update acquisition
scope/comments at `bangumi.ts:311–315,485` in the same change.

Proof: extend the existing dataset Bangumi test with named cases
`Bangumi cover binds the elected captured subject and source page` and
`cover extraction keeps nested image and user-post exclusions`; cover redirects,
absent holder, and alleged publisher/uploader without holder evidence. Change
the old empty-image expectation deliberately, not unrelated fact tests.
Acceptance: COVER-PIN candidate half; LIVE13/LIVE17 contribution.
Mechanisms: none. Content/Access migration: no/no. Native image build: no.
Wait: Launch agrees attachment evidence input shape (no service needed).

### 2. Freeze bytes and configure cover mapping — A, 45 min

Files/current anchors: `scripts/datasets/snapshot.ts:8–33,36–98,150–166`;
`network.ts:45–64,69–84`; `tests/qa/unit/dataset-core.test.ts:53,77,86`.
Hash and validate the full candidate/evidence; freeze its exact bytes with the
existing capture budgets and availability states. Normalize capture roles before
the `:79` prefix filter can select non-cover images for publication. An `all`
capture may retain other images; it does not grant them the cover role.

Extend the **reviewed provider mapping configuration** supplied by the
provider identity work (`G-1643-specification.md:82–156`) with source-page template,
elected cover field, explicit holder evidence field, image-origin constraints and
capture pacing as needed. Proposed upstream paths are
`model/source/provider-allowlist-v1.json` and
`model/source/mappings/<revision>.json`, with generated reviewed inputs under
`generated/model/inputs/source/`. They are **not present mechanisms in this
baseline**; their landed file/schema is a dispatch prerequisite. Cover/holder
selectors extend the mapping descriptor; pacing extends/consumes the provider
row. Their compiler/runtime changes remain with that owner. Do not invent a
cover-only registry. Normalized cover-provider identity is a reviewed string,
not another hard-coded union; retain existing acquisition selectors until their
owner changes them. Bangumi extraction adapts its captured row to the shared
descriptor; generic cover processing has no provider dispatch.
Do not broaden this session into rewriting every dump/API parser.

Proof: extend dataset-core with `cover evidence and bytes change snapshot identity`,
`cover capture preserves missing unavailable corrupt oversized and unsupported outcomes`,
and `a configured second cover source uses the same frozen pipeline`. Include
an actual dangling image: the existing `:77` title mentions images but tests
only an edge and duplicate record. The second source uses recorded fixture
bytes and changes only mapping config/fixture, no network.
Acceptance: COVER-PIN, COVER-CONFIG capture half; LIVE16/LIVE17 contribution.
Mechanisms: none. Content/Access migration: no/no. Native build: no for dataset
mapping consumption; upstream provider-row compiler/native work is a separate
dependency, not hidden in this session. Wait: slice 1 and the reviewed mapping
owner's published file/schema; Program answers the provider scope question below.

### 3. Media-owned imported-cover provenance — A, 55 min

Files/current anchors: `media/typed-schema.ts:14–23,42–80,102–147`;
`media/store.ts:54–89,260–266,356–375,467–499`;
new `services/content/migrations/<dispatch-number>_media_imported_cover.sql`;
new `services/main/tests/source-cover-provenance.test.ts`.
Extend upload intent and the asset revision manifest with a Media-owned typed
validator for verified provenance. `services/content/src/core.ts:698–739` and
`services/content/migrations/070_media_owner.sql:433–445` permit additional
manifest metadata; no authored graph shape is needed.
Persist the asset's cover-only invariant at creation and an indexed exact revision
projection for source record/observation → asset/original queries. Use the current
Content save/receipt transaction patterns; the index can be reconstructed from
sealed owner manifests and must not outlive erased evidence. Add current source
record/component and observation lookup indexes, not a provider table. Reads of
old ordinary assets need no invented provenance or batch backfill.
Extend the existing SQL asset immutability guard
(`services/content/migrations/070_media_owner.sql:216–232`) in the new migration.
Projection repair runs on both successful historical receipt and new save paths
(`media/store.ts:484–496`), or is atomic with revision insertion. Imported media
with a sealed manifest but missing/unverified index remains unavailable.

Proof: new named cases `cover provenance is sealed to the exact asset revision`,
`replacement cannot clear imported cover purpose`, `provenance reconstruction
keeps digests and refuses absent evidence`; cover mismatched observation/original,
same-key altered intent, ordinary non-imported assets, and interrupted revision
creation resumed through the existing upload receipt, including a crash after
manifest sealing but before projection indexing and successful-receipt replay.
Acceptance: COVER-BIND storage half, COVER-ROLE invariant half.
Mechanisms: `access-authority: consume` where admission is touched; rights-evaluation
is not reimplemented. Content/Access migration: yes/no. Native build: no.
Wait: slices 1–2 contract; Launch/Trust-ops review representation and retention.

### 4. Bind the API upload and forbid other roles — A, 60 min

Files/current anchors: `media/commands.ts:54–62,128–205,231–243`;
`routes/media.ts:83–97,113–151` and upload/selection handlers;
`media/store.ts:600–666,671–689`; `media/showcase-store.ts:140–152` selection
and campaign admission; `media/presentation.ts:325–337` document Use admission;
`media/presentation-contract.ts:39–40` document command schema;
new `tests/qa/integration/source-cover-attachment.test.ts`.
The existing Source owner verifies normalized evidence in the retained intake;
reuse `source/intake.ts:122–140,285–290`, adding a bounded typed cover verifier
in new `services/main/src/modules/source/cover-evidence.ts` only if no equivalent entry point exists
at dispatch. Route reservation intent must include provenance in its digest.
Bind before bytes can enter available public metadata; pin source and byte
identity in the sealed asset revision. Consume Launch's admitted cover command.
Check cover-only purpose in **all** non-cover use admissions, including campaign
override and publication; do not rely on the dataset caller avoiding them.

Proof: new exact-source mismatch, denied principal, same-key changed evidence,
lost transfer reply, stale/concurrent selection and interrupted bind cases.
Include a large chunked subject whose small cover observation is verified without
joining its fact-record parts, absent/altered cover observation and distinct
original-capture versus normalized-envelope digests.
Table-drive forbidden Agent-avatar, document, publication, showcase/campaign,
and banner admissions through their actual APIs, retaining ordinary art success.
Reuse `tests/qa/integration/media-api.test.ts:9` and
`tests/qa/integration/showcase-art.test.ts:78,211` for existing lifecycle/role fixtures;
run only new/modified files. No weakened safety assertions.
Acceptance: COVER-BIND, COVER-ROLE API half; COVER-CONFIG Main neutrality half.
Mechanisms: `access-authority: consume`; `rights-evaluation: consume` for current
use evidence; `governance-restriction: consume` for live source admission.
Content/Access migration: no/no after slice 3 and Launch's role migration.
Native build: no. Wait: slice 3; Launch cover API/authority/role contract;
Trust-ops imported-platform actor and admission contract.

### 5. Copyright mark on all cover descriptors — A, 50 min

Files/current anchors: `media/presentation-contract.ts:11–22`;
`media/presentation.ts:130–138,202–216` metadata query/assembly; `media/summary-contract.ts:22–31`;
`media/summary.ts:243–249,729–761`; `work/read-contract.ts:56`;
`discovery/read.ts:75–78,127`; `routes/search.ts:262,293–302`;
`search/result-cards.ts:207–226`; new
`tests/qa/integration/source-cover-read.test.ts`.
One shared typed credit projection accompanies image descriptors at these
surfaces. Preserve it through any locally redeclared Work/search schema found
by the compiler. Original/derived metadata resolves the pinned revision/Use,
not the latest mark on a different Asset head. Fold provenance into existing
batched Media reads; retain summary query budgets, order and unavailable shape.
Do not serialize source observation bytes or internal case identity publicly.

Proof: new `all available cover reads return the exact copyright mark and link`
across Work, resource summaries, discovery, quick search, query/search cards,
representation/metadata and thumbnail descriptors; no holder invention and no
CC BY-SA even when the Work's text carries it. Extend
`services/main/tests/media-summary-contract.test.ts:15`,
`tests/qa/integration/rights-obligation-read.test.ts:19`, and
`tests/qa/integration/search-card-rich.test.ts:11,138` where directly affected:
hidden/fallback has no mark; fact/text duties remain unchanged; batch cost stays
bounded. No new mark storage on derived images.
Acceptance: COVER-MARK API half; LIVE17, VIEW07/08 contributions.
Mechanisms: `rights-evaluation: consume` only for existing duty reads;
`governance-restriction: consume`; `access-authority: consume`.
Content/Access migration: no/no. Native build: no. Wait: slices 3–4.

### 6. Source-cover fence at writes and reads — A, 50 min

Files/current anchors: `rights/store.ts:210–257`;
`media/commands.ts:128–205`; `routes/media.ts:285–303,357–383,531–586`;
`media/summary.ts:729–761`; `media-rendition/store.ts:224–240,314–352`;
new `tests/qa/integration/source-cover-restriction.test.ts`.
Extend the existing component restriction lookup into a typed bounded cover
lookup using slice 3 provenance and the authoritative Access fences. Do not
copy assessment tables or let Media decide whether a notice is valid. Apply
current source_apply restriction during reservation/installation/refresh and
the authorized read/delivery restriction before descriptor/bytes/304; final
read assembly and transform settlement use the same owner outcome. Record-wide
and exact-observation rules follow the approved G-1803 target, never a dataset
URL blacklist. Index lookups and batched reads must fail closed on owner failure.

Proof: new changed observation/URL/digest, human-confirmed reapply, concurrent
restriction/install, denied lookup, owner outage and all URL-form cases. Extend
`tests/qa/integration/media-delivery-cache.test.ts:110` for old ETag after takedown;
`tests/qa/integration/media-rendition.test.ts:410–443` for derived metadata/bytes;
`tests/qa/integration/search-card-rich.test.ts:138` for restriction during
hydration and Work title/fact preservation. Assert subsequent requests cannot
return 304 or stale image fields after the fence is effective.
Acceptance: COVER-FENCE; GOV24, VIEW07/08 contributions.
Mechanisms: `rights-evaluation: extend` existing restriction read entry point;
`governance-restriction: consume`; `access-authority: consume`.
Content/Access migration: no/no if slice 3 indexes cover the reads. Native build:
no. Wait: slices 3–5, G-1803 scope/freshness decisions and Trust-ops review.

### 7. Source notice reaches the complete media closure — A, 60 min

Files/current anchors: `governance/evidence.ts:230–277`;
`governance/effects.ts:12–22,95–137,164–199`;
`governance/store.ts:1072–1086,1159–1218`; `media/store.ts:824–918`;
new `tests/qa/integration/source-cover-takedown.test.ts`.
Extend existing owner effect planning to resolve source-cover evidence through
the indexed provenance into exact Media originals/Uses. Use the existing effect
continuation, operation identity and receipt acknowledgement for a complete
bounded closure, including retained originals that are not today's selection.
Extend the existing saved EffectPlan/cursor binding; it currently names one
original, so a continuation alone is not a qualified multi-original plan.
Source fences from slice 6 protect partial settlement **only after** G-1803/
Trust-ops supplies the transition ordering identified above. Do not let a new
continuation silently delay enforcement until the last page. Re-read current
owner heads under its normal CAS/replay protocol; a stale Media state
does not erase the authoritative Access fence or pretend the closure settled.
Current moderation suppresses the entire Asset. Trust-ops must approve immutable
source scope per imported Asset (independent replacements get a new Asset), or
supply exact-revision suppression for the authorized scope. This report does
not choose between them; rereading a head never broadens decision authority.
Record all completed pages; zero matching assets is an explicit completed
source fence, not an error or a reason to drop the fence.

Proof: new `source cover notice suppresses originals and thumbnails while Work facts survive`,
`cover effects resume beyond one batch after a lost owner acknowledgement`,
`copyright cover restriction does not invent NCII digest closure`; include two
retained revisions, reused Uses, an unaffected independently sourced cover,
an independently sourced replacement on the same Asset, first-page pending
enforcement/refresh behavior under the approved ordering,
zero assets, stale head, transform in flight and failure mid-page. Reuse
`tests/qa/integration/rights-complaint.test.ts:26,158` scope/replay fixtures;
do not rebuild intake, moderation queue, deadlines or counter-notice in this slice.
Acceptance: COVER-EFFECT, COVER-FENCE owner effects; GOV24/GOV25 contributions.
Mechanisms: `governance-restriction: extend` existing owner effect adapter;
`rights-evaluation: consume`; `access-authority: consume`.
Content/Access migration: no/no on current evidence/fence vocabulary. Native
build: no. Wait: slice 6; G-1803 approved affected-copy/restoration contract and
Trust-ops review, including pending-fence ordering and exact-revision versus
Asset scope. Physical erasure, if required, waits for its existing owner task.

### 8. Dataset importer uses the media APIs — A, 50 min

Files/current anchors: `scripts/datasets/import.ts:239–243,408–413,483–545,695–745`;
`scripts/datasets/auth.ts:16–26,225–243`; `scripts/datasets/store.ts:30–40`;
`tests/qa/unit/dataset-import.test.ts:160,224,418,626`.
Add a generic image phase that verifies the frozen blob, maps source/observation
and native Work identities returned by earlier API receipts, reserves/uploads
with provenance, and calls Launch's exact cover selection operation. Reuse
existing immutable request/checkpoint journal. Extend it for media phase
responses/status rather than create another ledger. Deterministic intent keys
include snapshot/candidate/target; never choose identity from the source URL.
Replays consult current fences even when a previous upload/selection succeeded.
Do not silently overwrite an editor's new selection after stale-head refusal.
Submit the small cover-evidence observation described above even when the main
record required multipart intake. Preserve its canonical source record identity,
scoped coverage and separate envelope/original-capture digests. Add bounded
binary transfer to the existing DatasetApi transport: it currently JSON-stringifies
all bodies. Use the actual Main upload destination/authentication; never send
credentials to the provider image URL. Checkpoint byte digest and local blob
reference, not raster bytes embedded in JSON journals. Handle token renewal,
transfer failure and a lost successful JSON response through existing retries.

Proof: extend dataset-import with `cover import resumes lost reserve transfer and selection replies`,
`cover pending denied restricted and unavailable outcomes preserve imported facts`,
`a configured second provider uses the identical cover API sequence`, and
`import retry never replaces an editor cover after stale selection`.
Fake HTTP checks exact pinned bytes/digests and keys; live acceptance uses the
existing media stack fixture in slice 11. Maintain the importer facts' original
checks and absence of unexpected network access.
The second-provider fixture supplies an already mapped native Work and canonical
source identity from reviewed configuration to the generic image phase. It
must not run through the still closed provider-specific acquisition/native
projection switch and claim that switch has become configuration. Include a
large record whose ordered parts still reconstruct correctly, missing/reordered
parts for that facts phase, and an unchanged verifiable compact cover observation.
Acceptance: COVER-IMPORT, COVER-CONFIG import half; LIVE13/16/17 contributions.
Mechanisms: none (API adapter; no copied authority or rights rule).
Content/Access migration: no/no. Native build: no. Wait: slices 1–7 and enabled
operator admission; actual C-24 source evidence remains external.

### 9. Web preserves and renders cover credit — A, 50 min

Files/current anchors: `apps/web/features/api/media-metadata.ts:25–44`;
`packages/ui/src/components/media-image.tsx:27–36`;
`apps/web/features/catalogue/work.ts:56–59`; `catalogue/cover.tsx:5–17`;
`catalogue/work-tile.tsx:22–34`; `rights-mark/rights-mark.tsx:6–9,60–84`;
`rights-mark/messages.ts:16`; `apps/web/tests/media-metadata.test.ts:5,21`;
`apps/web/tests/rights-mark.test.tsx:20–143`.
Carry the server's structured credit through metadata and selected-cover props.
Extend the existing rights-mark feature with a cover credit renderer that
renders the provided text/source link separately from fact/text obligations.
Render a compact accessible credit next to each imported identifying cover,
including compact cards, headers and SSR; never hide it inside an aria-hidden
Work link or nest a source link in that link. The generic raster renderer need
not invent holder/licence text. Hidden/generated fallback renders no stale mark.
Launch owns final placement, localization and masked-image presentation, while
the API guarantees credit data on every available cover read.

Proof: extend existing metadata/rights-mark tests with exact round-trip fields,
known/unknown holder, all UI locales, RTL/mixed scripts, long names, valid source
link, no fake licence, and hidden/generated fallback. Add cover cases to
`apps/web/features/catalogue/catalogue.stories.tsx:31` and
`apps/web/features/rights-mark/rights-mark.stories.tsx:23`; review changed stories
with the storybook-ui-review skill, only the changed stories, against the shared
backend. Existing cover consumers must compile without locally fabricated marks.
Acceptance: COVER-MARK rendered half; VIEW08/LIVE17 contribution.
Mechanisms: none. Content/Access migration: no/no. Native build: no.
Wait: slice 5 API and slice 6 hidden behavior; Launch rendering decision.

### 10. Remove imported cover fallback into showcase art — A, 35 min

Files/current anchors: `apps/web/features/showcase/slide.tsx:39–52,194–212`;
`apps/web/tests/showcase-delivery.test.tsx:55–128`;
`apps/web/features/showcase/showcase.stories.tsx:106`.
Use the API's cover-only provenance marker, not a provider name or URL heuristic,
to prevent imported-cover ambient/background/preload paths. Independent selected
showcase art remains eligible. The allowed identifying-cover placement follows
Launch's answer below; if the entire showcase occurrence is prohibited, render
only admitted independent art/generated treatment there. Do not decide that a
blurred decorative duplicate counts as cover use.

Proof: named case `imported cover never supplies showcase ambient art or background preload`;
assert no prohibited source/srcset/preload, while ordinary admitted showcase
art still displays, framed cover placement matches the reviewed decision, masks
still prevent fetch, and keyboard/source-credit access works. Review the changed
story screenshot; backend rejection from slice 4 remains necessary for API clients.
Acceptance: COVER-ROLE rendered half; VIEW08 contribution.
Mechanisms: none. Content/Access migration: no/no. Native build: no.
Wait: slices 5/9 and Launch role interpretation. This is a real existing role
leak, not optional cover-import polish.

### 11. End-to-end restriction and recovery qualification — A, 75 min

New files: `tests/qa/integration/source-cover-import.test.ts` and
`tests/qa/fault-recovery/source-cover-restriction-replay.test.ts`.
Existing fixture anchors: `tests/qa/integration/media-support.ts:43,66`;
`tests/qa/fault-recovery/rights-restriction-replay.test.ts:108`;
`tests/qa/fault-recovery/media-recovery.test.ts:11`;
`tests/qa/integration/search-card-rich.test.ts:11,138`.
No product changes are prescribed; a newly exposed defect goes to its owner
with exact evidence, not a bypass in the test.

Proof: drive a frozen Bangumi record and image through the actual source/media
APIs, read identical credit on original/thumbnail/Work/search, submit a scoped
notice and approved decision, then assert all retained URL forms and validators
unavailable and facts/search result surviving. Exercise changed-source refresh,
human reapply, lost effect acknowledgement, concurrent rendition settlement,
counter-notice without decision, authorized restoration and existing recovery
hold/reconciliation after an Access/Content restore. Reuse one built fixture
and isolated restored copies; do not start another backup/restore mechanism.
If existing admitted erasure is part of the chosen outcome, qualify its held
evidence/non-resurrection path through Trust-ops' landed fixture rather than
rewrite erasure. Browser rendering is proved by slices 9–10; these backend
tests do not claim human usability or real-device acceptance.

Acceptance: COVER-PIN/CONFIG/BIND/ROLE/MARK/FENCE/EFFECT/IMPORT/RECOVER composed
API proof; GOV24/GOV25/LIVE17/VIEW07/08 contributions. Program registers these
precise assertions; no claim that broader IDs become green from two files.
Mechanisms: `governance-restriction: consume`; `rights-evaluation: consume`;
`access-authority: consume`. Content/Access migration: no/no. Native build: no.
Wait: slices 1–10, G-1803 approved restoration/recovery, Trust-ops media recovery
and any explicitly required erasure closure. QA uses goalctl, not whole tiers.

## Cross-Goal dependencies, classification and decision questions

The read-only goalctl status snapshot showed G-1803 running (kernel rights
path specification), G-1783 running (Trust-ops command-custody erasure), and
G-1781 exited (immutable-object erasure). Briefs
`docs/goals/trust-ops/tasks/G-1793.md:15–20` and
`G-1798.md:15–20` prescribe later bounded media/custody/restore work.
These are dependency evidence, not proof they have landed. No currently running
Launch cover API task was established by status; its pending contract is the
explicit wait, and the manager must claim/dispatch it with Launch rather than
assign its paths to kernel by assumption. Recheck owner claims at dispatch.

| Work | Class/reason | Ownership and required answer |
| --- | --- | --- |
| Existing CoverSet selection seam and exact role admission | A dependency: imported identifying covers need a real admitted selection. | Launch: which API/role is the first-scope cover, how does it map to the existing Work-avatar slot, and which cover ratios/contexts/crop/fallback must this import support? Is current media.avatar authority sufficient? Launch owns any Content role CHECK migration; Access migration only if Trust-ops approves changed authority. No native build inherent in PG slots. Do not bundle the entire pending avatar/banner design into an importer session. |
| Source-to-media evidence representation | A: precise marks and restrictions need exact identity. | Launch/Trust-ops: approve optional immutable manifest provenance plus its derived Media index, versus an existing equivalent attachment field discovered at dispatch. A graph Statement of copyright ownership is not required; holder evidence remains evidence, not accepted ownership. |
| Notice target and affected-copy semantics | A dependency: refresh must not resurrect restricted cover bytes. | Trust-ops/G-1803: record-wide cover component versus exact observation/Asset/Use; which linked copies are authorized, which effect channels apply, how is immediate restriction ordered against concurrent reads/writes, and how does authorized restoration lift each effect? This report recommends record-wide cover refresh fencing but does not decide it. |
| Pending-fanout enforcement ordering | A dependency: a partial owner closure currently delays its Access fence. | Trust-ops/G-1803: approve the restriction transition ordering in `governance/store.ts:1159–1218`, with a first-page pending test proving source refresh and linked delivery cannot escape. Extend that owner, not a kernel shadow fence. If this is not already in G-1803's slices, dispatch a separate owner slice and revise the ten-hour estimate. |
| Asset-wide versus exact-revision suppression | A dependency: current `moderateOriginal` can suppress an unrelated replacement on the same Asset. | Trust-ops: must imported Asset source binding be immutable (a new source uses another Asset), or does the Media owner need exact-revision restriction? Define the denied/stale replacement outcome and prove the same-Asset independently sourced case before slice 7. Extra owner implementation beyond the chosen small binding rule needs its own sizing. |
| Suppression versus physical deletion | A decision dependency if Program means physical deletion by “removes everywhere”; existing public suppression is sufficient for delivery removal only. | Trust-ops/Program: is retained rights evidence allowed, must dataset captures be erased, and which existing erasure/hold admissions cover the copies? Consume the current journal/closure implementation; do not infer delete authority. |
| Showcase occurrence interpretation | A: current code decorates with a cover. | Launch/Program: may an identifying framed cover appear inside a carousel, or does “never showcase art” exclude that occurrence too? Decorative ambient/background reuse cannot be presumed allowed. Resolve before slice 10. |
| All provider acquisition rewritten as configuration | C for this cover wave: generic cover capability is required; a universal dump/API parser is a different function. | Program: does “a new provider is configuration, never code” describe the cover path after normalized source records, or the complete acquisition/parsing subsystem? Current `types.ts:3`, `cli.ts:60,91–113`, `network.ts:69–71` and provider-specific parsers cannot establish the latter. If the latter is required for first scope, reclassify that separate work A and resize the ten-hour plan; do not falsely claim it from a shared image type. |
| Native image Work promotion, gallery credit index, extra banners/showcase imports | C: no first-scope identifying cover needs them; imported-cover art is prohibited in those roles. | Existing image Work/media owners remain separate; no task here. |
| General CDN/cache purge machinery or new thumbnail engine | C: existing delivery revalidation and rendition gates supply the necessary function. | Only add work if the focused retained-URL/conditional-read proof exposes a concrete deployed bypass. |
| Extra providers beyond the second configuration proof and richer optional presentation | B: first elected cover works without wider source rollout or cosmetic variants. | Launch/source stewards select later enabled sources; do not delay A slices for them. |

Questions are manager handoffs, not permission requests to a worker. Resolve them
in existing owners/contracts before dependent sessions; workers do not invent
policy defaults merely because the ten-hour estimate is tight.

## C-24 and evidence that remains external or unestablished

Exclude **C-24 external conditions**: deciding enabled catalogue sources,
naming stewards/backups, supplying real pinned production dumps, dated source
licence/rights evidence and acquisition/retention permission for particular
image surfaces. Software must carry exact evidence and enforce approved decisions;
obtaining that evidence or selecting a legal basis is not a Goal implementation.
Provider URLs and a copyright mark never establish image reuse clearance.

`docs/operations/external-conditions.md:38` still calls Bangumi unlicensed and
barred, citing the older `docs/research/source-data-rights.md:69`, whereas the
newer decision-55 contract explicitly includes Bangumi text and covers. Program
must reconcile the production-plan wording and evidence through its owner;
this worker did not edit either document, override C-24, or decide production
eligibility. Legal policy/DMCA agent registration and required matcher provider
accounts remain their existing external conditions, not cover implementation.

Could not establish: the approved Launch cover route/role schema; the landed
reviewed-provider mapping file; source-specific image retention permission;
whether a reliable holder field exists in captured Bangumi records; the approved
copyright copy/restoration scope; physical erasure requirements for dataset
captures; broad acceptance registration; deployed cache behavior or real rendered
credit usability. Evidence that settles them is, respectively, Launch's reviewed
route/schema and tests, the provider owner's committed config/compiler, C-24
dated evidence, a pinned source row with explicit holder evidence, G-1803 and
Trust-ops approved decisions/tests, the retention/erasure owner contract, Program's
registered exact proofs, and the focused API/cache/browser checks above.

The hypotheses are the manifest/index representation and session durations;
the observed gaps are static code evidence. None of the local COVER labels is
green yet. The specification is complete when the manager can dispatch each
bounded slice with its owner decisions and named proofs, not when this report
pretends the absent implementation has passed QA.
