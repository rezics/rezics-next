# Source observations, mapping and native adoption

## Identity and authority

A SourceRecord uses provider/namespace/external identity. An Observation captures
the exact fetched representation, acquisition time, coverage, source revision and
provenance. Equal bytes at different observations do not erase causal history.
A Binding maps source grains to native targets; native identity remains independent.

Default to preserving original bytes in controlled object storage and a structured
source graph in Jena under the intake policy below. Record actual acquisition or
retention limits and omitted fields; reproduction requirements cannot expand rights.
Preserve unknown/absent/null/zero, lexical forms, qualifiers, order and
unmapped fields. A failed or narrower fetch cannot withdraw previously observed
data outside its declared coverage. Credentials and excluded-private fields do
not enter public source graphs.

## Basis for acquisition and reuse

REZICS includes a collaborative wiki operated by a U.S. company. Neither that
company status nor the wiki purpose is a blanket decision about commercial use,
copyright protection or permission. Manual entry and automated import distinguish
unprotected facts from expressive text, images and original compilation structure.
See the [U.S. legal and provider evidence](../research/source-data-rights.md).

The operating policy is to maximize data intake and preservation, retain provenance
and rights evidence, and respond to concrete complaints at the affected scope.
Company status, an NC marker or incomplete license information alone does not
reject intake or force blanket quarantine. Do not impose universal legal clearance
or a separate permission request before every entry or import; reuse source/field
rules for ordinary cases. Missing rights information remains explicitly unknown,
not a fabricated permission or a conclusion that the use is unlawful.

Record available evidence for the relevant material and operation: original
contribution, unprotected facts/public domain, applicable license or permission,
or a reasoned statutory exception such as fair use. Intake acceptance records an
operational decision, not legal clearance. Known restrictions, concrete evidence
of infringement and effective complaint decisions require scoped action; the
absence of a complaint cannot override them.

Assess API/service eligibility and retention terms separately from data rights.
Acquisition, storage, wiki display, search and redistribution can have different
bases and conditions. NC is use-specific; ShareAlike alone does not prohibit
commercial use. Preserve attribution and applicable sharing obligations through
mapping and export. A supported wiki use does not automatically authorize a paid
feed, full dump or different downstream use. Keep uncertain rights visible without
excluding independently supported facts or contributions from the provider.

## Complaints and source continuity

Use [content governance](content-governance.md#rights-complaints) for notices,
targeted restriction, decisions and appeals. A complaint about one image, synopsis
or use does not automatically remove every fact from the provider or the native
resource's identity. Apply the actual decision scope to raw payloads, derived
fields, search and media, and prevent refresh/reimport from restoring restricted
material. Human confirmation changes edit control, not the rights in copied
expression. Retain independently supported facts and permitted evidence; physical
deletion follows the [erasure owner](../operations/erasure.md) when required.

## Conversion and adoption

The pipeline is acquire -> preserve -> parse -> map -> propose -> validate -> adopt
-> publish where applicable. Each stage has an operation identity and explicit
outcome. Source-supported knowledge remains queryable without native adoption
within its recorded use and disclosure scope.
Raw payload storage alone does not qualify structured conversion.

`POST /v1/sources/intakes` is the first private manual staging operation. It
records provider, namespace and external ID as separate identity grains and
keeps each submission as a distinct immutable observation. A retained payload is
limited to 64 KiB and read back with its SHA-256 digest; a `not-retained` submission
stores neither payload nor claimed byte digest. Coverage, omitted fields and
rights evidence remain explicit. The server records submission time rather than
claiming it fetched the source. The receipt is idempotent per active principal
and request key. Only that principal can read the staged observation through
`GET /v1/sources/observations/{observation}`. This operation does not acquire a
provider response, accept native facts, create a source graph, or authorize reuse.
Staging uses a separate `source` PostgreSQL schema in Main's existing database;
the Content migration runner currently owns its installation sequence. Native
adoption still requires its graph and authority operation.

`POST /v1/sources/acquisitions/open-library/works` is a bounded acquisition
profile for one Open Library Work ID. It constructs the fixed official `.json`
URL, refuses redirects and non-200/malformed/oversized responses, and preserves
the exact JSON bytes, response ETag/Last-Modified when present, fetch time and
source revision as a private staged observation. A PostgreSQL provider gate
reserves at most one request per second across Main instances; a queue over three
seconds returns a retryable rate response. A successful idempotency replay uses
the original observation without refetching. No failed fetch has a completed
intake receipt, and no observation becomes native solely by capture. This profile
does not support bulk acquisition or a general caller-supplied URL. Open Library's
[official Works API](https://openlibrary.org/dev/docs/api/books) defines the
Work JSON path; its [usage guidance](https://openlibrary.org/developers/api)
prefers low-volume human-facing lookup, asks for identification and gives a
one-request-per-second default limit for unidentified requests. The current
profile stays within that default rate; production credential/contact policy
and live provider conformance still need qualification.

`POST /v1/sources/observations/{observation}/conversions/open-library-work`
applies `open-library-work-map-v1` only to a complete retained Work response. It
stores an immutable private source projection: the source Work key and title are
candidate facts, description remains source expression, and author keys and
subjects remain source-qualified references/terms. Every top-level field gets a
disposition. Recognized but unconverted fields are marked retained-only; new or
unsupported fields are marked unmapped-retained. Their exact original values
remain in the observation bytes, including numeric lexical forms that JSON
number conversion might lose. Wrong Work/Edition grain and incomplete capture
fail without a conversion. The conversion and exact read use the same principal
boundary as the observation. No source title, description, author or subject is
yet an accepted native Work fact; identity correspondence and rights remain
separate decisions.

`GET /v1/sources/conversions/{base}/drift/{candidate}` compares two private,
complete Open Library Work conversions of the same SourceRecord. It verifies both
immutable projections against their retained observations and reports each
top-level field as added, removed, changed or unchanged, with both mapping
dispositions. `representationChanged` separately records any exact-byte change,
including lexical or formatting differences that do not change parsed field
values. A removed field is a source observation, never an instruction to withdraw
native facts; narrower captures cannot be converted or compared. A cross-record
comparison fails, and the endpoint does not mutate source or native state.

`GET /v1/sources/conversions/{base}/child-correspondences/{candidate}`
compares source-only author references and subject terms from two verified,
complete conversions of the same SourceRecord. Each array member receives an
observation-qualified occurrence identity and original ordinal. A unique key on
both sides can correspond across reorder; a changed author role remains visible.
Repeated keys on either side are ambiguous and receive no correspondence. A
missing or unmapped list is unavailable rather than evidence of child removal.
This assessment does not create native child identity or authorize adoption.

`POST /v1/sources/correspondences` records one explicit source-only child
correspondence for an ambiguous same-key pair from that assessment. It requires
`source:correspond`, the active source principal and an idempotency key. The
server re-verifies both retained complete conversions, the same SourceRecord,
the two exact observation-qualified occurrences and their source key. PostgreSQL
enforces one-to-one pairing for each ordered conversion pair and field; another
choice or key conflict returns 409. The decision is immutable, and
`GET /v1/sources/correspondences/{correspondence}` rechecks the retained source
evidence before a private read. It neither merges source observations nor
creates native child identity. Different-key correspondence and manual
resolution of missing/unmapped lists require a later explicit profile.

`POST /v1/sources/conversions/{conversion}/source-graph` projects one verified,
complete Open Library Work conversion into Jena's private
`urn:rezics:graph:source` graph. Its three source-qualified nodes are the
SourceRecord, Observation and Conversion. The graph contains source key, title,
description, digest, coverage, revision, rights evidence and ordered author and
subject arrays as JSON literals. It does not create a native Work, publish text or
grant reuse. Main verifies the immutable PostgreSQL conversion and observation,
requires `source:convert` and an active Access principal, then sends one fixed
source command with three reviewed SHACL focuses. The command gate restricts the
source graph to this receipt family, rejects source deletions and unreviewed
predicates, binds all three identities and the digest to its receipt, and records
the product sequence and an outbox event atomically. Repeating the operation uses
the conversion-derived receipt and returns its original graph position.
`GET` on the same path requires `source:read` and the observation's principal;
it verifies the exact source triples and receipt before returning the private
projection. A lost graph write response can be resolved by its receipt. Full
source-graph restore and native adoption remain separate qualification work.
The first held-restore replayer verifies one retained source event against the
relay's exact batch/coverage and immutable PostgreSQL conversion and observation,
then restores the original source nodes, receipt, outbox event and ordered cursor.
It rejects changed or missing evidence and preserves the original graph position.
This one-event path does not yet qualify an entire mixed-cut source/adoption
backup or automatic replay of every event family.

`POST /v1/sources/conversions/{conversion}/proposals/native-work` records one
private, immutable proposal for a new native Work from a verified source graph.
It requires `source:propose` and an active Access principal. The proposal freezes
the SourceRecord, Observation and Conversion identities, byte digest, graph
receipt and position, exact candidate title, and the observation's rights evidence.
Only a title within the native Work title limit is eligible; an incompatible title
returns 422 without truncation. Repeating the conversion returns the original
proposal, even if the graph is later reprojected at a different position. A
conversion without a source graph returns 409 and creates no proposal.
`GET /v1/sources/proposals/{proposal}` requires `source:read` and the same active
principal, and checks that retained source evidence and graph still match. The
proposal keeps description, author references and subjects source-only. Its
`rightsStatus` is `undetermined`; recording a proposal neither clears reuse nor
creates a native Work. A later adoption operation must decide target identity,
authority, field use and rights independently.

`POST /v1/sources/proposals/{proposal}/adoption/native-work` is the first
title-only native adoption profile. The caller must affirm the proposal's exact
candidate title and explicitly select English for the current native Work
metadata profile. It requires both `source:adopt` and `work:create` Account scopes,
an active source principal, and a current Access Work creation admission for the
selected acting Agent. The source owner reserves one private, immutable intent
and server-generated Work idempotency key per proposal before dispatch. The
guarded Work command creates a metadata-only Work and Main Version; a separate
immutable source binding then records that Work's receipt, admission and graph
position. If binding persistence fails after graph commit, retry recovers the
same Work receipt and completes the binding. Conflicting title or acting Agent
cannot create a second Work for the proposal. `GET` on the same path privately
checks the retained binding against the native receipt.
Only the title is adopted; source description, author keys and subjects stay
source-only. The response keeps rights undetermined, and a title confirmation
does not clear expressive reuse or a later export. This first profile cannot
adopt a non-English title or an existing native Work. A denied Work authority
attempt leaves a reserved source intent for the same acting Agent to retry after
authority is restored; changing Agent requires a later explicit resolution path.
The source binding is held in the private PostgreSQL owner, not yet projected as
native source-support triples. Complaint, refresh, human edit-control and
source withdrawal behavior remain unqualified.

`GET /v1/works/{work}/source-support` is a private reverse read for this first
title-only binding. It requires `source:read` and the active source principal,
looks up the immutable binding by native Work identity, verifies the proposal,
source graph and Work receipt, and returns the source title value, observation,
conversion, proposal, graph receipt and adoption receipt. It reports both the
revision where the title was adopted and the current Work head. A later Work
edit, including one that repeats the same title, makes
`appliedRevisionIsHead` false while preserving the historical source support.
This read does not itself assign edit control or apply a refreshed source value;
those commands still need a field-control protocol. Another principal receives
no private source evidence through this path.

`GET /v1/works/{work}/source-refresh-assessments/{candidateProposal}` compares
one later verified private source proposal with the Work's title-only adoption.
It requires the same SourceRecord and principal, then reports whether the source
title and exact retained representation changed, the adoption revision, the
current Work head and whether that head moved since adoption. A same-value Work
edit changes the head assessment even when the visible title does not change.
The assessment does not mutate the Work, assert which source version is newest,
clear reuse rights or authorize a field application. Cross-record comparisons
fail, and another principal cannot inspect either proposal through this path.

`POST /v1/works/{work}/source-title-applications/{candidateProposal}` applies a
confirmed changed title from one later private proposal. It requires
`source:adopt` and `work:edit`, the same principal and SourceRecord, an active
Work edit representation/grant, and an expected Work head. The candidate source
graph position must be strictly later than the source-controlled base in the
same data epoch. This first profile advances only from the original adoption
revision or a previous recorded source title application. Any other head,
including a same-value human edit, is human-controlled and conflicts. The
source owner reserves an immutable intent and server-generated Work edit key;
the native command compare-and-swaps the expected head and retains its exact
receipt. A separate immutable application binds that receipt to the proposal.
Retry after a lost or failed binding write resolves the same native edit, while
`GET` on the same path verifies the private source and Work evidence. Source
application remains title-only and leaves rights undetermined. A human edit
after application takes control at its new head; a later source application
cannot overwrite it. Different source epochs, unchanged titles and ambiguous
provider ordering require a later resolution path. A stale graph edit may leave
a reserved source intent that cannot be retargeted automatically.

Account's Main resource admits distinct `source:intake`, `source:acquire`,
`source:convert`, `source:propose`, `source:correspond`, `source:adopt` and
`source:read` OAuth scopes. Each staged API verifies the
current bearer through Account and requires an active Access principal before
its owner operation. A read-only token cannot start an intake, provider fetch or
conversion. Deactivating the principal blocks both later writes and private
reads without changing retained source observations. This is staging authority;
native adoption needs a separate target and grant check.

The staged write has a fixed number of indexed PostgreSQL lookups and inserts per
request, with O(B) hashing/storage for B at most 64 KiB. Its private read is an
indexed observation lookup plus O(B) integrity verification and response bytes.
The Open Library path adds one bounded HTTP attempt, a fixed-size response buffer
and one shared provider-rate reservation; retries after a completed capture do
not make another provider call.
Conversion processes one retained response of at most 64 KiB, admits at most 128
top-level fields and makes one indexed immutable conversion write/read. It has
O(B + F log F) local work for B response bytes and F fields, plus O(B) retained
source reads; no graph or downstream native write occurs.
Drift comparison performs four indexed private reads and processes at most two
64 KiB captures and their bounded field inventories. It uses bounded-depth
canonical comparison of parsed values; excessive nesting fails rather than
reporting an incomplete comparison. The exact bytes remain available for lexical
inspection.
Child comparison uses the same two verified bounded captures and at most 128
author references plus 256 subject terms per side. Hash maps provide O(A + S)
matching in the two list lengths, with no provider call or native write.
Recording a selected ambiguous pair adds one immutable indexed PostgreSQL
insert/read and the same bounded verification. Its exact read is one indexed row
lookup plus bounded re-verification; neither path scans unrelated source records.
Projection has a fixed three-subject graph footprint and one native transaction
with a fixed receipt/outbox event. It reads one conversion and its at-most-64 KiB
observation through indexed private owner lookups, validates the three selected
source nodes, then uses bounded receipt and graph checks for the private read.
No corpus scan or provider call occurs during projection or replay.
Proposal creation performs an indexed conversion/observation read, a bounded
source-graph verification and one immutable PostgreSQL insert/read keyed by the
conversion. The private read uses an indexed proposal lookup and verifies its
retained source evidence; it makes no provider call or native graph write.
Adoption adds one unique-key intent insert/read, the existing guarded Work create
command, and one unique-key immutable binding insert/read. Its private read
uses indexed source lookups and one exact Work receipt query. Per-request work
is independent of the source corpus size, subject to the native Work command's
existing fixed graph and object writes; no source refresh or corpus scan occurs.
The reverse source-support read starts with one unique Work-key lookup, then
bounded private proposal/binding verification and one exact current-head query.
It does not enumerate other Works or source records.
Refresh assessment adds one indexed candidate-proposal read to that bounded
path and compares two retained digests and titles; it does not fetch a provider
or scan source history.
Source title application adds a fixed number of indexed intent, application and
proposal reads plus the existing guarded Work edit command and one immutable
binding write. Its native Work write is O(1) in the source corpus size and
compare-and-swaps one target head; it performs no provider fetch or source scan.
The implementation does not yet include a physical SQL-plan or remote-byte
counter; those remain required for full cost qualification.

Field applications record base source observation, mapping revision, target head,
human-control epoch and correspondence. Same-value human confirmation takes over
control just as a changed value does. Source withdrawal removes that support only;
other sources and independent native confirmation survive. Reapply cannot undo a
later human edit. Redirects/merges propose identity correction; they never transfer
grants, ratings or content ownership.

## Child correspondence and structure

Repeated tracks, chapters, ingredients, names and credit participants retain
occurrence identity. Use observation-qualified keys when provider child keys are
unstable. Reordering, split/merge or reused keys can yield conflict rather than
false correspondence. Large bundles stage bounded pages, validate complete coverage
and activate under target/binding/authority generations.

## Change intake and reconciliation

Bootstrap dumps and changes overlap deliberately with dedupe and a recorded
frontier. Gaps trigger targeted reconciliation or a new baseline. A query returning
no row is not necessarily a deletion signal. Rate limits, retries and streaming
joins have provider-specific budgets. Imports cannot synchronously starve product
transactions or rebuild every search document.

Every run fetches current official contracts and representative data; per-run
snapshots support reproduction without freezing future versions. Keep source
coverage, native mapping, query and export qualification separate. See
[source acceptance](../testing/source-conformance.md) and [worker service](../services/workers.md).
