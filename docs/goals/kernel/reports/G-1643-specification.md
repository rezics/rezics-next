# Provider identity: implementation slices

Read-only specification against commit `639ae047a37ef8c5a90f59e37b87233525f34a80`,
2026-10-11. Paths and line numbers below refer to this worktree at that commit;
later workers should find the named function after preceding slices move lines.
No product code, tests, generated artifacts, image or running stack was changed.
No failure was reproduced: conclusions about current refusals are static evidence,
not QA results. The two requested new test files do not exist yet.

Path notation: `routes/`, `modules/`, `source/` and `work/` below expand under
`services/main/src/` (`source/` and `work/` are modules). Bare source-module
filenames such as `intake.ts` share `services/main/src/modules/source/`.
Java policy/registry filenames expand under
`infra/jena/command-module/src/main/java/com/rezics/jena/`; Java test filenames
under `infra/jena/command-module/src/test/java/com/rezics/jena/`.

The original task is `docs/goals/kernel/tasks/G-1593.md`; the evidence report is
`docs/goals/kernel/reports/thesis-test-provider-and-composition.md`, Case 1 and
ranked change 1. This specification replaces its session sizing, not its owner
decisions. Each numbered slice below is one proposed Luna/max session, one
bounded capability change and a commit. Session fit is an estimate, not measured
Luna execution evidence. Dispatch the slices separately, with the listed claims;
do not give one worker the entire original path list.

## Outcome and scope correction

Identity substitutions alone cannot make the requested acme proof green. The
operator's manual intake has no network capture; conversion requires that
capture and directly reads Open Library JSON. Credits also face unlisted SQL,
SHACL, occurrence and read gates. The minimum complete reduced proof needs a
reviewed extraction mapping in addition to identity lookup and consumption of
the existing disposition owner. These additions are identified explicitly below.

Slice 15 makes `tests/qa/integration/source-provider-unseen.test.ts` green for
the **reduced change-1 proof**: retained manual acme bytes, a mapped Work title,
source synopsis text with no native acceptance, and one explicitly confirmed
native author credit. It must have no provider-specific Main or Java edit when
acme is configured after the engine is frozen. Source-only synopsis is projected
and reified; it is not installed as the Work's native editorial synopsis.

**No slice here makes the full report's Case 1 thesis proof green.** That proof
also asks for one statement per declared field and an accepted page-count fact.
`reification.ts:13-23,57-58` and `SourceProjectionPolicy.java:84-117` still admit
only title/description claims. Those changes belong to ranked change 3. Claiming
full thesis success from the reduced proof would be false.

## Findings and drift

A means an existing function is incomplete or wrong for the opening proof and
must be repaired before claiming it. B can follow that opening; C is deferred.

| Class | Current evidence and disagreement | Consequence / reason |
| --- | --- | --- |
| A | `routes/sources.ts:75-84,647-652`, `source/intake.ts:130,140`: manual intake supplies no `capture`. `open-library-conversion.ts:94-99` requires acquisition/capture; `graph-projection.ts:62` dereferences it; `source-open-library-work-v1.ttl:34` requires fetched time. | Identity-only edits cannot admit the brief's manual fixture. Preserve true manual provenance; do not invent a fetch. |
| A | `open-library-conversion.ts:60-74,117-142` still reads `key`, `title`, `type.key`, `description`, `authors`, `subjects`. | The table's “required paths come from mapping” is not an existing mechanism. `heading`, `blurb`, `credits[].person/role` need an extractor; not a 35-line substitution. |
| A | Conversion mapping literals also occur at `open-library-conversion.ts:32,146,191,197`; `verifiedRead` at `:222-235` reruns the OL parser. Route response `sources.ts:117` fixes mapping; conversion handler `:366-374` ignores the submitted profile for selection. | Generalize storage, verification and contract together; caller-supplied mapping must agree with the observation's reviewed row. |
| A | `services/content/migrations/042_source_field_disposition.sql:69-92` already admits general mapping revisions and enforces their sealed inventories. `173_source_synopsis_field_mapping.sql` registers OL description as a native synopsis candidate. | Do not add a second disposition policy. New inventory must use actual source grain/field and the existing owner. Legacy OL vocabulary has an explicit exemption at `042:75`; acme does not. |
| A | `source/author-credit.ts:105-106` requires legacy `authors/source-reference` and an `authors` occurrence; `:69-72,201-206` passes no participant identity. `native-work-adoption.ts:228` rejects non-OL reported author keys. | These sites are missing from the brief's acceptance list; source credit owner is also outside its claim. Fabricating an acme `authors` inventory would violate provenance and SQL. |
| A | `services/content/migrations/019_source_author_credit.sql:15`; `model/definitions/work-author-credit-v1.ttl:16-18,39-41`. | Unlisted credit key/provider gates require a new migration and authored shape change before acme credit. Do not edit old migrations. |
| A | `work/author-credit.ts:27,38,54,85,91-92,110`; report says copy observation namespace. | Parent namespace is `work`; OL participant namespace is `author`. Participant namespace/key grammar must come from the reviewed credit mapping, provider from observation. Acme `AC-P-1` cannot use work pattern `AC-1`. |
| A | `work/title-control.ts:31,534`; `native-work-adoption.ts:607,694`; `routes/source-supports.ts:92,137`. | The report/brief omit control response/request schemas and the title mapping type. Module-only edits still fail at HTTP boundaries. |
| A | `native-work-proposal.ts:21-23,48-49` fixes the Book annotation and OL source-only fields. | Generic source names and type evidence cannot be inferred from OL defaults. Preserve OL output, derive generic proposal metadata from its reviewed mapping and existing type owner. |
| A | `modules/outbox/relay.ts:419,1115,1127`; `source/reconcile-restored.ts:16,46,66,88-92`. | Unlisted delivery/recovery gates would strand a successful acme projection. Generalize readers before enabling its writer. |
| A | `ProfileRegistry.java:58-81` hashes TTL profiles, not arbitrary data. `model/compiler/generate.ts:101-151`; `infra/jena/Dockerfile:56-57` copies only manifest/shapes at runtime. | “Follow the existing pin” needs compiler, native input loader and runtime packaging changes, outside the brief's claim. A JSON file cannot be disguised as a TTL profile. |
| A | `model/tests/source-turtle.test.ts:541-569,696,711-719,734,740` freezes original shape constraints and rejects non-OL identity. | Widening the authored shape cannot keep these assertions unchanged. Update current-contract expectations explicitly while retaining historical fixtures and OL behavior tests unchanged. |
| B | `provider-identity.ts:102-104` already accepts direct external-ID equality; only the `/works/…` alternative is OL-specific. | Replace that alternative with the row's template; identity redirects are not required for initial acme conversion. |
| B | `intake.ts:165-187,219-229` gates OL at 1000 ms, accepts author/work capture and revision-qualified `?v=` URLs. | General capture work can follow manual opening. A single plain URL template does not encode all existing capture variants; preserve the owner checks pending an explicit compatible representation. |
| C | Report's `EditorialFieldPolicy.java:166` row also proposes a slot-declared value predicate; current `:170` uses `sourceDescription`. `field-application.ts:50,111` uses description and persists that source field. | Mapping equality belongs here; generalized slot/predicate and native acme `blurb` provenance are change 3. Reduced proof does not accept synopsis. |
| C | `author-facts.ts`, VNDB, recipe SLOT, Bangumi, acquisition-run/feed parsers, author-page/public presentation grammar. | They are different field/parser or fetching surfaces. No widening of this task to them; no claim that every provider surface is opened. |

The old table's `CommandService.java:385,1427` admission sites are now
`:320-321,1257-1258`. Its profile identifiers are still fixed. Retaining the
shared historic profile ID avoids needing that admission expansion. The route
constants remain at `sources.ts:28,38`, but execution is at `:360-379` and
`:599-630`; changing constants alone does not repair handlers and schemas.
`SourceProjectionPolicy.java:57,72` and `EditorialFieldPolicy.java:166,169` remain
at the reported lines. “About 14 places / 35 lines” is an old edit estimate,
not support for the current complete acceptance.

## One reviewed owner and concrete data contract

Author `model/source/provider-allowlist-v1.json` (new) as:

```json
{
  "version": 1,
  "providers": [{
    "provider": "open-library",
    "namespace": "work",
    "captureProfile": "open-library-work-acquisition-v1",
    "mappingRevision": "open-library-work-map-v1",
    "externalIdPattern": "^OL[1-9][0-9]{0,11}W$",
    "sourceKeyTemplate": "/works/{externalId}",
    "urlTemplate": "https://openlibrary.org/works/{externalId}.json",
    "minimumIntervalMs": 1000
  }]
}
```

One row per provider/namespace, exactly these fields. Hash the exact generated
file bytes, with mappings, in the existing generated manifest under a new
`reviewedInputs: [{id, file, sha256}]` section. Outputs are
`generated/model/inputs/source/provider-allowlist-v1.json` and
`generated/model/inputs/source/mappings/<revision>.json`. Keep TTLs in `profiles`.
Main and native policy load the same reviewed bytes, immutably; unknown tuple,
unreviewed revision, missing input, wrong hash or ambiguous row fails closed.
Never take a pattern, key template or allowlist row from the HTTP request.

“ONE lookup” means one authoritative row resolution by observation tuple per
operation boundary, passed to downstream functions. The native transaction must
independently verify that same reviewed row against committed/staged graph
identity and receipt. It must not trust Main's asserted row. This is enforcement
of one owner in two processes, not two provider registries. Receipt and conversion
mapping must equal that row's mapping; key must equal its template over external
ID. Direct identity evidence equality remains valid without an allowlist; only
template-based interpretation needs a reviewed row.

Validate templates as literal text with exactly one `{externalId}`, no execution.
Require anchored patterns in a shared tested ASCII subset (literal characters,
ASCII classes, grouping/alternation, bounded quantifiers; no flags, lookaround,
backreferences or Unicode shorthand). Reject control characters before matching
and require a whole-value match; test final newline and Unicode digits in TS and
Java. Do not add a regex library or tool. URL is capture metadata, not host
authorization. The interval belongs to the provider gate; reject conflicting
intervals for two namespaces of the same provider instead of inventing a winner.

The mapping is `model/source/mappings/open-library-work-map-v1.json` (new), not
a provider branch. Define its descriptor in slice 2 and evaluator in slice 4:
`version`, `id`, `rootGrain`, `mediaType`, `coverageScope`, identity selector and
representation (`external-id` or `source-key`), required constant checks, title
selector, optional description selector(s), optional subjects selector, and a
credit collection descriptor with item key/role selectors, participant namespace
and key grammar/template. Optional semantic type declarations refer only to
terms already admitted by the existing type owner; no implicit OL Book type for
a generic record. Selection uses bounded
[RFC 6901 JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901) paths, including
`~0`/`~1`, strict numeric array indices and own-property access; no wildcard or
executable callback. An array selector plus per-item relative pointers suffices
for credits. The standard defines selection syntax, not REZICS disposition or
authority. Prefer extracting/reusing the bounded pointer behavior already at
`provider-identity.ts:59-73` rather than inventing incompatible pointer semantics.

OL mapping describes `/key`, `/type/key = /type/work`, `/title`, string or
`/description/value`, `/authors` items `/author/key` and optional `/type/key`,
and `/subjects`. It preserves the existing malformed-optional-field-to-null
behavior, inventory sorting, limits, errors and omission/null distinctions.
The acme test mapping describes `/catalogueId` as external ID, `/heading`,
`/blurb`, `/credits` items `/person` and `/role`; proposed participant namespace
is `person`, key pattern `^AC-P-[1-9][0-9]{0,11}$`, native role remains the existing
author role after explicit confirmation, and `writer` remains source role text.
These acme participant choices are test fixture definitions, not established
production provider semantics. Mapping bounds stay within current input limits.

Extraction parameters supplement the existing mapping owner; they must not
override its `source.field_mapping` / `source.field_disposition` declarations.
For nonlegacy conversions, read sealed dispositions from that owner and retain
actual field names (`heading`, `blurb`, `credits`). Do not rewrite them into
legacy `title/description/authors` inventory. Internal `projection.title`,
`projection.description`, `projection.authorRefs` are compatible slot values,
not claimed source field names. OL's excluded field switch remains its legacy
compatibility writer; this work adds no generalized field-claim projector.

For fixture installation, the reviewed mapping also supplies its declaration
data to the existing sealed mapping transaction, once: title/blurb can remain
structured-source-only; credits declare the existing author-credit capability
with a concrete target such as `work-author-credit-v1#author`. The wildcard
`#*` in `LEGACY_SUPPORT_SLOTS` is a family marker, not a valid persisted target
(`042_source_field_disposition.sql:27`). The credit owner must recognize the
concrete family member; do not route it through general field support or add
a second accept policy. SQL remains the enforcement owner for disposition.
No mapping accepts a fact, synopsis or credit on behalf of a person.

Adding a provider is **a reviewed row plus a reviewed mapping** (including its
sealed declaration data), using the shared source shape and projector. The
production allowlist contains only OL work for this change. Test acme inputs
live under `tests/qa/fixtures/source-provider/`; never add a production acme row.
Its capture profile ID can be `source-acme-catalogue-v1` as in the report; manual
conversion uses the mapped coverage declaration without pretending a capture
was performed. Do not create one SHACL source shape per provider.

Retain the historic `source-open-library-work-v1` shared profile ID and OL
profile strings for compatibility; generalize its identity constraints, with
the native row gate enforcing concrete parameters. A name cleanup can follow
separately. Preserve OL receipt/digest families at `graph-projection.ts:30-45`
and native credit digest at `work/author-credit.ts:44-47`, serialized field
order, triples, source occurrence IDs and response envelopes. An adapter for
the old OL contract may construct its reviewed identity; a generic call with
missing identity must never default to OL. Semantic bytes are compared at fixed
IDs/times; HTTP status/header/replay compatibility is asserted too.

## Ordered sessions

The `PROVIDER-*` names below are proposed local test acceptance labels, not
already registered Goal cases. Existing LIVE/MODEL/OPS IDs name regression
coverage that stays green; they are not newly completed cases. `native: yes`
includes a qualified image/pin handoff as described after the slices. All slices
require preceding slices; optional B slice 16 follows the reduced opening.
Mechanisms for production slices: `rights-evaluation: consume — existing
acquisition/retention and explicit accept gates remain their owners; reviewed
identity/mapping data grants no rights.` Test-only slices need `none`.

### 1. A — Characterize OL compatibility

Files: new `services/main/tests/source-provider-compatibility.test.ts` and
`tests/qa/fixtures/source-provider/open-library-compatibility.json`; targets
`open-library-conversion.ts:92-142`, `graph-projection.ts:30-75`,
`work/author-credit.ts:36-63`, `intake.ts:103-109,219-238`.
Capture fixed-ID/time golden conversion JSON, inventory, graph text, receipt
digests, native credit text/digest and acquisition URL variants. Include malformed
optional values and manual observations without capture. No product changes.
Prove: new compatibility test; existing
`tests/qa/integration/open-library-conversion.test.ts` unchanged (LIVE01/02/04/07/13).
Acceptance: `PROVIDER-COMPAT`. Mechanisms: none. Native: no.

### 2. A — Authored allowlist and Main reader

Files: new `model/source/provider-allowlist-v1.json`,
`model/source/mappings/open-library-work-map-v1.json`,
`services/main/src/modules/source/provider-allowlist.ts`,
`services/main/src/modules/source/provider-mapping.ts` (descriptor/schema only),
`services/main/tests/source-provider-identity.test.ts`,
`tests/qa/fixtures/source-provider/identity-vectors.json`.
Define exact row/mapping descriptor schema, immutable loader, tuple lookup,
template expansion and TS parity vectors; production row is the exact OL work
row above. Author the complete OL mapping data using the contract above; its
evaluator arrives in slice 4. Reader accepts
an explicit manifest/input directory; production wiring waits for slice 3's
generated hashes. Do not replace live consumers yet.
Prove: new identity test plus slice 1; duplicate tuples, unknown pair, pattern,
URL/template, interval and malformed-row refusal. Acceptance: `PROVIDER-ROW`.
Mechanisms: rights-evaluation consume. Native: no; no generated image input yet.

### 3. A — Pin and package reviewed inputs

Files/anchors: `model/compiler/generate.ts:101-151`,
`model/compiler/generate.test.ts`, `ProfileRegistry.java:45-81`,
`infra/jena/Dockerfile:7,56-57`; new `SourceProviderRegistry.java`,
`SourceProviderRegistryTest.java`, and reviewed-input fixture JSON under
`infra/jena/command-module/src/test/resources/source-provider/`.
Generate/hash the allowlist in `reviewedInputs`, load it through the existing
registry, and copy inputs at runtime. Use the same parser/validation vectors,
safe in-directory paths, duplicate detection and missing/hash mismatch refusal.
If Docker's native test resources need a copy of the shared vector fixture,
verify that copy byte-for-byte against the TS fixture in the compiler/unit test;
the copy must not become a separately authored source of identity decisions.
Pin/load both authored OL inputs from slice 2, without parsing mappings as TTLs.
Keep native projection behavior unchanged. Prove: generator tests, new Java
registry test and existing `RegistryProfileTest.java`; `PROVIDER-PIN`,
`PROVIDER-PARITY`. Mechanisms: rights-evaluation consume. Native: yes.
For existing non-source Java fixture manifests that omit `reviewedInputs`, the
registry may represent source admission as unavailable; any source operation
then refuses. Production generation always emits required inputs, and missing
listed bytes/hash mismatches fail load. Add explicit fixture-absence tests;
never substitute an implicit OL registry or relax production hash validation.

### 4. A — Bounded reviewed mapping extractor

Files: extend `services/main/src/modules/source/provider-mapping.ts`; new
`services/main/tests/source-provider-mapping.test.ts`. Target semantics are
`open-library-conversion.ts:60-142`
and pointer evaluation `provider-identity.ts:59-73`.
Create the test-only acme descriptor at
`tests/qa/fixtures/source-provider/acme-catalogue-work-map-v1.json` here, so
selector tests do not depend on the final proof slice.
Implement pure normalization into the existing Work slots, actual source field
metadata and participant descriptor. Consume the already pinned mapping files;
validate matching row revision, bounded pointers and required constants. Do not
replace disposition ownership or wire converter yet. Test OL output equivalence,
acme selectors, wrong grain/id, missing heading, null/omitted description,
malformed credits, role/key mismatch and pointer escaping. Acceptance:
`PROVIDER-MAP`. Mechanisms: rights-evaluation consume. Native: no; the complete
mapping data was pinned in slice 3. If characterization requires changing that
reviewed input, report it and rebuild/pin rather than claiming a TS-only change.

### 5. A — Conversion storage and verified reads

Files/anchors: `open-library-conversion.ts:27-37,92-100,145-157,173-235`,
`services/main/src/composition.ts:254-257`, `routes/dependencies.ts:224`;
new `tests/qa/integration/source-provider-conversion.test.ts` and acme mapping
fixture under `tests/qa/fixtures/source-provider/`.
Also create `acme-catalogue-work-v1.json` and the test row here, and a fixture
installer that uses the existing generated manifest format plus a sealed
`source.field_mapping`/`field_disposition` transaction. All later tests reuse
these fixture inputs; slice 7 transports them to native policy. This is test
data installation, not a new production mapping admission API.
Resolve observation tuple once, require requested mapping agreement, accept
complete retained manual observations with mapped coverage, and use slice 4's
extractor. Preserve legacy OL conversion entry point/contract. INSERT, replay
SELECT and verified recomputation use the resolved revision. The existing
`convert` entry point remains a legacy wrapper selecting the OL revision;
add the general executor separately until slice 9 wires its route. Thus the
legacy route cannot accidentally choose acme before native readers are ready.
Read nonlegacy inventory dispositions from sealed rows and mark undeclared fields explicitly
unsupported; use original fields/grains. Reuse migration 042, no new conversion
table or permissive SQL bypass. Runtime/recovery default constructors load the
same immutable reviewed input; test constructors may inject a verified fixture.
Prove: new conversion integration test and existing manual-intake/conversion
tests unchanged; denied owner, corrupt digest, wrong revision, incomplete bytes,
concurrent replay and unknown mapping leave no conversion. Acceptance:
`PROVIDER-CONVERT`. Mechanisms: rights-evaluation consume. Native: no.

### 6. A — Native source and editorial mapping admission

Files/anchors: `SourceProjectionPolicy.java:46-73`,
`EditorialFieldPolicy.java:120-121,162-170`, `CommandService.java:1019,1070`,
`model/definitions/source-open-library-work-v1.ttl:12-17,34,42,53`,
`model/definitions/source-reification-v1.ttl:26`,
`model/tests/source-turtle.test.ts:541-569,696,703-740`;
new `SourceProjectionPolicyTest.java`, `EditorialFieldPolicyTest.java`.
Pass the reviewed registry to policies; bind provider/namespace/external ID,
receipt/conversion mapping and derived key in the transaction. Widen the ONE
shared source record shape to bounded strings; concrete restrictions move to
this native gate. Make fetched time optional, not fabricated. Reification's
mapping becomes bounded text checked against conversion/receipt; keep its
title/description predicates, field names, counts and source-only disposition.
Editorial changes only mapping equality/row admission, keeping synopsis slot
and sourceDescription value check. Adjust current shape tests explicitly;
preserve historical fixtures and unchanged OL integration tests.
Prove: both new Java tests, `model/tests/source-turtle.test.ts`, slice 1 and
existing `source-reification.test.ts` (MODEL09). Refuse unknown tuple, wrong key,
mapping or ambiguous identity before success; confirm rollback leaves no receipt.
Acceptance: `PROVIDER-NATIVE`. Mechanisms: rights-evaluation consume. Native: yes.

### 7. A — Test-only reviewed-input fixture transport

Files/anchors: `scripts/qa/cli.ts:390-417`, `stack-environment.ts`,
`scripts/dev/cli.ts:27-29` and its Compose assembly,
`scripts/qa/isolated-integration-files.ts:5+`; new
`scripts/qa/source-provider-fixture.ts`, its `.test.ts`,
`tests/qa/integration/source-provider-fixture.test.ts`, and a test-only Compose
overlay outside `services/main`/`infra/jena` if the existing assembly needs one.
Prepare the provider fixture directory under `.temp/` before stack startup,
using the existing manifest generator/validation. Select it ONLY for named
isolated provider tests. Mount read-only into that QA project's Fuseki and use
the existing `-Drezics.profiles=<directory>` property (`CommandModule.java:37`);
Main test receives the same verified directory. Copy baseline profiles, append
acme reviewed row/mapping and recompute hashes; production inputs remain OL-only.
No native code, test allowlist bypass, shared-dev refresh, or image rebuild.
Register explicit isolated test files; preserve normal startup budgets and
teardown. Prove: helper/selection tests for ordinary-file exclusion, malformed
input, cleanup and byte identity; new fixture integration test constructs a
bounded native source-projection command with the same receipt/provenance
schema, proving acme row admission and altered-row refusal. This verifies fixture
transport, not the later API journey. Acceptance: `PROVIDER-FIXTURE`.
Mechanisms: none. Native: no. The exact mount plumbing is not present today and
must be established here; if existing Compose ownership prevents it, return
that exact owner blocker. This slice precedes every acme native integration test.

### 8. A — Delivery and recovery readers before new projection

Files/anchors: `modules/outbox/relay.ts:409-420,1107-1137`,
`source/reconcile-restored.ts:16,35-51,66-92`,
`graph-projection.ts:48-75` and its `readReified` rendering;
new `services/main/tests/source-provider-event.test.ts` and
`tests/qa/fault-recovery/source-provider-projection.test.ts`.
Copy and verify the event's actual mapping against conversion/record and the
same reviewed tuple. Replace the OL-only refusal/ASK. Restored reads use the
same registry/extractor and exact current or supported legacy receipt identity;
retain held Access fence, prior epoch/cursor checks and source-only outcomes.
Move generic pure renderer/read support here: provider/namespace come from
observation and fetchedAt is conditional on real capture. OL text stays exactly
unchanged. Recovery can therefore render manual acme evidence before slice 9
exposes its general producer. Use slice 7's native fixture/command helper to
establish the source graph needed by the recovery test.
No new projection route yet. Prove: new event and recovery tests, existing
`tests/qa/fault-recovery/source-projection-recovery.test.ts` unchanged
(MODEL09/OPS03/LIVE01/02/03/05/13). Unknown/forged mapping, stale epoch,
missing bytes and interrupted replay fail closed without cursor advancement.
Acceptance: `PROVIDER-DELIVER`, `PROVIDER-RECOVER`. Mechanisms: rights-evaluation
consume. Native: no; native source admission was delivered by slice 6.

### 9. A — Generic projection and conversion contract

Files/anchors: `graph-projection.ts:13,30-45,137-140` and producer entry point,
`routes/sources.ts:38,110-125,167-175,360-379`,
`routes/dependencies.ts:224,239`; new
`tests/qa/integration/source-provider-projection.test.ts`.
Wire slice 8's renderer into the general producer; preserve both historic
receipt/digest identities exactly.
Add `/v1/sources/observations/:observation/conversions` with the reviewed mapping
revision; retain OL route/body alias using one handler and admission owner.
Schemas admit actual mapping and both legacy/general inventories without
losing grain/reason. Keep shared graph profile ID; do not add a Java admission
list or new provider profile. Prove: new manual acme projection test with test
registry, event read and title/description source statements; existing
`source-graph-projection.test.ts`, `source-reification.test.ts`,
`open-library-conversion.test.ts` unchanged. Acceptance: `PROVIDER-PROJECT`.
Mechanisms: rights-evaluation consume. Native: no. Changed API requires
`task gen`, Main and web typechecks; generated outputs are not committed.

### 10. A — Proposal, native title and mapping control plumbing

Files/anchors: `native-work-proposal.ts:11-25,43-53,70+`,
`native-work-adoption.ts:607,694`, `work/title-control.ts:31,534`,
`field-control-native.ts:27,64`, `routes/sources.ts:178-186`,
`routes/source-supports.ts:92,137`; new
`tests/qa/integration/source-provider-title.test.ts`.
Reconstruct mapping/source-field metadata from verified conversion evidence;
copy conversion mapping into title intent/control and response schemas.
Generic proposal source-only field names are actual mapped source names; keep
the OL tuple/profile/output exactly. Generic semantic type annotation must come
from the reviewed mapping through the existing type owner, or be absent where
that owner permits it; do not claim OL Book/source-record-type evidence for a
record that never supplied it. Cover that distinction in the proposal test and
response schema. Generalize synopsis mapping type/check,
but do not accept acme blurb as native synopsis or change field-application's
value/persisted-field rules. Existing TitleControlPolicy already equality-binds
source mapping at `:129`; do not add another title admission owner.
Prove: new acme title adoption/control test, existing
`services/main/tests/work-title-control.test.ts`,
`tests/qa/integration/work-title-control.test.ts`, `source-adoption-language.test.ts`,
`source-field.test.ts` unchanged. Stale head, human control, denied authority
and wrong mapping cannot adopt; retries return the original title result.
Acceptance: `PROVIDER-TITLE`, mapping part of `PROVIDER-CONTROL`.
Mechanisms: rights-evaluation consume. Native: no; API generation/web typecheck.

### 11. A — Credit intent storage admits general keys

Files: new next-free-number `services/content/migrations/*_source_credit_key.sql`,
new `tests/qa/integration/source-provider-credit-storage.test.ts`;
current restriction `019_source_author_credit.sql:15`.
Replace the OL key CHECK with a bounded nonempty text/no-control constraint;
provider-specific grammar remains reviewed mapping admission, not SQL branches.
Do not rewrite migration 019, immutable intent history, owner proof or CAS rules.
Test old/new keys, invalid controls/oversized values, migration on existing OL
rows and rollback. This storage opening does not enable a native credit writer.
Acceptance: `PROVIDER-CREDIT-STORAGE`. Mechanisms: rights-evaluation consume.
Native: no. Manager renumbers migrations on merge.

### 12. A — Native credit identity shape and gate

Files/anchors: `model/definitions/work-author-credit-v1.ttl:16-18,39-41`,
its declaration `work-author-credit-v1.ts:13-17`,
`AuthorCreditPolicy.java:70-105,107+`; new `AuthorCreditIdentityTest.java` and
`model/tests/source-credit-identity.test.ts`.
Generalize provider/participant namespace/key constraints and enforce reviewed
participant identity in the native credit owner. Preserve role=author,
HumanConfirmed, Undetermined, immutability and Work head/protection gates.
Use optional conversion context in the existing binding for new generic writes
to resolve the parent row and its mapping's credit descriptor; historical OL
bindings remain supported under that same reviewed OL mapping. Never interpret
parent `work` namespace as participant namespace. No parallel allowlist or raw
request-selected regex. This session produces the reader/gate only; writer is
slice 13. Optional binding metadata may refine the existing profile; if a
tightened admission constraint is needed, author a new revision with admission
coverage rather than silently tightening old credit history.
Nonlegacy identity requires receipt/admission-bound conversion context. Missing
context is accepted only for exact reviewed OL provider/author/key identity;
never default arbitrary input to OL. Current and revision identity must agree.
Settle/prove compatible binding design before widening admission. If a new
revision is necessary, dispatch its design/admission coverage as a separate
preceding session, then implement this slice with the resolved contract.
Prove: new model/Java tests, existing `CreditSeekKeyTest.java`,
`TitleControlPolicyTest.java` and slice 1;
unknown provider, mismatched conversion/namespace/key, and identity differing
between current/revision are refused. Acceptance: `PROVIDER-CREDIT-NATIVE`.
Mechanisms: rights-evaluation consume. Native: yes.

### 13. A — Mapped credit writer and native read identity

Files/anchors: `source/author-credit.ts:69-72,96-110,201-206`,
`work/author-credit.ts:20-28,36-75,85-111`, `author-credit-schema.ts:15`,
`child-correspondence.ts:5,34-40` (occurrence helper only);
new `tests/qa/integration/source-provider-credit.test.ts`.
Consume the sealed mapping's concrete credit target and real source field,
derive its occurrence from `credits` and ordinal, and carry participant identity
and authenticated parent-conversion context through native values, stored
immutable intent values, triples, native reads and replay. General reads retain
provider/namespace equality between current/revision. Reconstruct metadata from
immutable conversion evidence for retry instead of defaulting to OL.
Preserve legacy digest bytes and author occurrence identities. The human still
confirms the exact participant key/role and ordinal under existing Work authority.
Widen the occurrence helper to a bounded reviewed source field, leaving OL
correspondence comparison unchanged. Acme initial adoption/replay is in scope;
acme refresh/correspondence is B. Refuse unsupported generic base-support
refresh explicitly rather than constructing an `authors` correspondence.
Prove: new acme credit adoption test; existing `source-author-credit.test.ts`
(LIVE04/MODEL05/MODEL06) unchanged. Include denied, stale, concurrent/retried,
withdrawn and independent support outcomes for initial adoption. Acceptance:
`PROVIDER-CREDIT-WRITE`. Mechanisms: rights-evaluation consume. Native: no.
API generation/web typecheck if result schema changes.

### 14. A — Reported credit read and retained recovery

Files/anchors: `native-work-adoption.ts:214-233`,
`source/reconcile-author-credit.ts:41-73,89-108`,
`source/author-credit.ts` replay/read paths if shared reconstruction is needed;
new `tests/qa/fault-recovery/source-provider-credit.test.ts` and extend slice
13's integration proof with reported-author reads.
Use the same immutable conversion/participant descriptor to validate reported
keys and reconstruct generic native credit values for held recovery. Preserve
the signed stored intent/digest, source-before-credit recovery order, Access
fence, original authority and immutable history. Do not add a new binding owner.
Prove: new recovery/read tests and existing fault-recovery
`source-author-credit.test.ts` (LIVE04/05/MODEL06/OPS03) unchanged; missing source,
wrong participant, changed mapping, replay after response loss and withdrawn
support cannot create another credit or release the fence early. Acceptance:
`PROVIDER-CREDIT-READ`, `PROVIDER-CREDIT-RECOVER`. Mechanisms:
rights-evaluation consume. Native: no; context/gate was delivered in slice 12.

### 15. A — Frozen-engine unseen-provider proof

Files: new `tests/qa/integration/source-provider-unseen.test.ts`, existing
`tests/qa/fixtures/source-provider/acme-catalogue-work-v1.json`, test-only row,
`acme-catalogue-work-map-v1.json` (with sealed declarations), and test inventory
registration where the QA owner requires it. No engine/product modifications.
Freeze slices 1-14 with OL-only production reviewed inputs; record engine/source
hashes, then activate acme in a fresh isolated reviewed fixture directory using
only row/mapping data and the proof test. Earlier selector/negative fixtures
are test data, not engine branches or production activation. POST actual bytes
through manual intake, generic conversion,
source projection, proposal/title adoption and explicit credit adoption using
only the authorized routes. Assert heading/title, blurb/source text and its
structured-source-only statement, AC-P-1 credit/role/provider/person namespace,
exact retained bytes and replay, event delivery, and native synopsis absent.
Include unknown tuple/revision, wrong identity, partial/malformed capture,
denied principal, stale Work, lost-response retry and no fabricated fact/agent.
Read title/credit back through public contracts. Assert the source remains
private to its owner, source rights remain undetermined, and no fact acceptance
was issued. Pair the same OL fixture with byte/digest equality.
Prove: new test plus existing source regressions listed below, unchanged except
the explained authored-shape expectation update in slice 6. Acceptance:
`PROVIDER-UNSEEN` — **reduced proof green here; full thesis stays red/deferred**.
Mechanisms: none. Native: no. The activation comparison must show an empty
diff under `services/main` and `infra/jena` relative to the frozen engine;
the full implementation branch necessarily changed those directories earlier.

### 16. B — Capture/rate/identity consumers after manual opening

Files/anchors: `intake.ts:25,165-187,219-238`,
`open-library.ts:7,15,59-98`, `provider-identity.ts:95-105`,
`routes/sources.ts:28,95-107,599-630`; new
`services/main/tests/source-provider-capture.test.ts`.
Use reviewed work row identity/interval/URL parameters; preserve queue bound
3000 ms, transactional provider gate, response/metadata bounds, manual digest
and old work acquisition alias. A general acquisition body names provider,
namespace, externalId but still consumes the existing fixed-host acquisition
authority: unknown host never causes a request. Identity evidence's template
alternative uses reviewed row; direct external-ID equality stays generic.
Prove: new capture unit test; existing `open-library-acquisition.test.ts`,
`source-run-acquisition.test.ts`, `source-identity.test.ts`, manual intake and
slice 1 unchanged (LIVE01/02/06/09/11/13/16). Acceptance:
`PROVIDER-CAPTURE-WORK`, `PROVIDER-IDENTITY-TEMPLATE`. Mechanisms:
rights-evaluation consume. Native: no if only consuming already-reviewed work
data; a new reviewed capture/mapping input would require a build.
Do not add a made-up OL author mapping. Preserve existing author and `?v=`
capture validation; removing every author-specific literal needs the owner's
compatible capture-variant representation and belongs to a separately sized
follow-up. This limitation means the original G-1593 capture acceptance cannot
be declared wholly complete from the reduced proof.

## Native image, pins and proof discipline

Slices **3, 6 and 12** need native image builds: compiler-generated inputs,
Java/tests, authored TTLs and Docker COPY inputs all enter the image hash
(`scripts/dev/fuseki-image.ts:35-50`). Merely adding a Java test changes it.
After each native slice, run `task gen`; it updates generated profiles,
Compose stamp, `scripts/dev/release-manifest.ts` and toolchain inventory
(`scripts/generate.ts:13-24`). Generated files and Compose image stamp are not
worker commits. Follow the original pin deferral to the manager until dependency
landings are established; report exact pin/toolchain owner changes. Do not
hand-edit a tag or bump `pom.xml` for a data-only change.

The native build must include Dockerfile's Maven package line (`Dockerfile:15`)
and the new unit tests. `task release:images` does **not** build Fuseki:
`scripts/ops/release-images.ts:342-348` inspects its existing image. The existing
Task build path is `task toolchain:install`, which also performs other toolchain
setup. Program's qualified `task dev:refresh` runs the targeted Compose Fuseki
build (`scripts/dev/refresh-stack.ts:123-142`) with its lifecycle admission and
45-minute budget. There is no verified narrower worker Task build entry here.
Manager arranges Program's build/pin/refresh after each native merge, before the
next consumer's QA. A worker must not refresh or write the main checkout.
The acme activation in slice 15 uses reviewed fixture inputs on that already
qualified image; rebuilding the engine just to admit acme would invalidate the
frozen-engine proof.

Use `bun scripts/goal/goalctl.ts test <explicit files>` for worker QA, one run at
a time; logs under `.temp/`, retain QA run IDs. Do not run whole tiers. For Java,
submit explicit Java test paths through the coordinator; if that runner cannot
select them, record its refusal and obtain the Maven-qualified image evidence
from Program rather than silently claiming they ran. Implementation slices run
their affected workspace typechecks, relevant type-aware lint/ast-grep and
`task gen:check`; changed API contracts also need `task web:typecheck`.
Documentation/toolchain changes need `task docs:check`. These are instructions
for implementers; none were run in this read-only specification task.

Existing source regression selection for slice 15 / manager, by actual file:
`tests/qa/integration/open-library-acquisition.test.ts`,
`open-library-conversion.test.ts`, `source-manual-intake.test.ts`,
`source-graph-projection.test.ts`, `source-reification.test.ts`,
`source-author-credit.test.ts`, `source-adoption-language.test.ts`,
`source-identity.test.ts`, `source-field.test.ts`,
`tests/qa/integration/work-title-control.test.ts`,
`services/main/tests/work-title-control.test.ts`,
`services/main/tests/source-author-name.test.ts`,
`tests/qa/fault-recovery/source-projection-recovery.test.ts`,
`source-author-credit.test.ts`, `work-title-control.test.ts` (last two under
fault-recovery). Run live-network tests only if assigned; their existence is not
permission to add network fetching. Review the affected-test list for callers
outside each slice and hand it to the manager, without running unrelated suites.

## Unestablished points and manager actions

1. No source test or actual unseen-provider refusal was executed. A baseline
   coordinator run plus the negative tests in slices 1/5 establishes runtime
   refusal and OL compatibility; this specification does not claim either run.
2. G-1546/G-1584/G-1573/G-1592 task files are absent from this worktree's kernel
   tasks directory. Their landing/pin status cannot be established from those
   referenced briefs. Manager's authoritative merge/dependency records settle
   this before native pin commits; do not infer “landed” from code similarity.
3. Reviewed-input QA mount/selection is not implemented. The JVM profile-dir
   property exists, but ordinary coordinator startup has no provider-fixture
   transport. Slice 7's isolated stack test must establish the same native/Main
   bytes and no image/source edits; in-memory Main injection alone is insufficient.
4. Native credit currently carries `sourceIntent`, an opaque intent IRI, not
   enough context to derive parent mapping inside Java. Slice 12 must prove its
   optional conversion binding/context is receipt/admission-bound and the
   source graph is read in validation. If this requires tightening old profile
   admission or changing authority, split a new revision/coverage session before
   slice 12's native opening. Do not relax a shape and assume Main-only validation
   proves native command safety. This is the material conditional split in the
   estimate.
5. Author capture has no established work-conversion mapping row and accepts
   revision-qualified URLs. One URL-template column cannot replace that whole
   grammar faithfully. Existing author capture tests plus the owner's chosen
   data representation settle a future B task; do not fabricate its revision.
6. Before dispatch, expand/reassign claims for compiler/Dockerfile,
   `composition.ts`, source-credit owner, source-support route, outbox/recovery,
   Content migration, credit model and QA fixture owners. These are outside
   G-1593's listed paths. Workers check `goalctl owner`; an active owner claim is
   a real blocker, not permission to edit it. This report changes none of them.
7. Remove the original 35-line budget. Report actual non-test source diff/stat
   against the frozen base and explain correctness gained by each new file:
   one reviewed input reader, bounded extractor, existing-owner consumers and
   fixture transport. No measured code-size or Luna-session claim is available.

Class-level audit boundary: the API-only operator's retained-byte journey was
traced through model, command, read, delivery and recovery, including denied,
partial, stale and retried states. There is no changed UI and no demonstrated
human usability result. C follow-ups are field-disposition projection/native
synopsis provenance/facts (change 3), all other provider parsers/presentation,
and the full platform expansion protocol; B is compatible broader capture and
mapped credit refresh/correspondence.
The acceptance guard is the frozen-engine unseen-provider API proof plus OL
byte comparison, not a count of removed provider strings.
