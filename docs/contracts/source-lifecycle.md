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

Account's Main resource admits distinct `source:intake`, `source:acquire`,
`source:convert`, `source:propose` and `source:read` OAuth scopes. Each staged API verifies the
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
Projection has a fixed three-subject graph footprint and one native transaction
with a fixed receipt/outbox event. It reads one conversion and its at-most-64 KiB
observation through indexed private owner lookups, validates the three selected
source nodes, then uses bounded receipt and graph checks for the private read.
No corpus scan or provider call occurs during projection or replay.
Proposal creation performs an indexed conversion/observation read, a bounded
source-graph verification and one immutable PostgreSQL insert/read keyed by the
conversion. The private read uses an indexed proposal lookup and verifies its
retained source evidence; it makes no provider call or native graph write.
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
