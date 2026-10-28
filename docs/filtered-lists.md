# Filtered lists

This document owns the shared membership, freshness, disclosure, admission, identity-list and cost contract for
Zone pages, TypeLists, Collection browsing and the library. Owner documents specify their obligations and native
integration. This is required behavior, not a claim that the existing stubs, helpers or native ports implement it.
[Scope](scope.md) includes the architectural capability wherever these abstractions appear.

## Meaning and indexed observations

Membership is evaluated against a **complete, identified index observation** for the admitted predicate and
population. Meaning, indexed observation and current disclosure are separate. Catalogue facts use the existing
OpenSearch/PostgreSQL machinery. State, labels, progress and holdings stay in the owner's PostgreSQL partition;
private facts never enter a public index or a public holder directory.

Use the one [filter grammar](../packages/filter/README.md), immutable release pins, datatypes and units. All
qualifiers on a statement must match that same statement. Unknown remains unknown under NOT; incomplete coverage,
a failed dependency, a timeout or partial shards cannot establish absence. Complete indexed negatives do not
require request-time reconstruction of every raw selected fact. The Search pure matcher is the conformance
reference, not mandatory request-time raw-fact replay. Typed, parameterized range and qualifier SQL is permitted
where admitted with the same meaning. This does not admit arbitrary SQL or enlarge the grammar.

Semantic supplies complete selected-public-facet projections and their disclosure dependencies, covering compact
and expanded storage, rank, adoption, suppression, retraction, consent and foreign dependencies. A relation sample,
possible-witness hint or overflow marker alone is not complete coverage for exact membership or negatives. Use a
complete access path or preparation. Search owns compilation, preparation and freshness; Commerce owns owner-local
plans; Performance owns numeric budgets and native cost verification. No new engine, service or scheduler is needed.

## Current disclosure and query privacy

Everything disclosed must satisfy current native authority: membership, exclusion, order, fields, source metadata
and cursor-visible information. Current Access, original **and** terminal eligibility, source consent, foreign
target restrictions and tuple fences remain required. A public page uses public facts even for an editor who can
inspect private facts. A Zone or Collection grant never grants rights in its sources or subjects.

An index revision, complete ordinary generation, identity epoch or prepared result is never a grant or cached
permission. Plans require complete disclosure dependencies and fail closed when essential observations are missing,
unavailable or unsafe. Candidate checks alone cannot protect a query's exclusions and order.

For example, withholding a harem tag must prevent disclosure through a positive harem result **and NOT harem**.
A stale index can exclude a readable book using the withheld tag. Checking only the returned subjects never checks
that excluded book. The same problem applies to ordering, counts and source metadata.

A required abstract producer/consumer seam therefore provides **query-level privacy-reduction invalidation and
acknowledgement in addition to candidate checks**:

- Local privacy reductions invalidate public use in their authoritative transaction.
- Foreign source-fence, target, consent and Collection reductions invalidate affected public use immediately.
- Acknowledgement covers actual refresh-visible projection repair, including all dependent foreign repair, before
  query disclosure. Dispatch, an event checkpoint or local repair alone is not acknowledgement of that work.
- Observe the required current safety state before execution and revalidate it before disclosure. Unsafe, changed,
  missing or pending acknowledgement means preparation/readiness, never stale exclusion, order or results.

Ordinary relay checkpoints, local `securityRevision`, complete ordinary index generations, returned-row checks and
omitting counts cannot certify query privacy. Keep this seam separate from ordinary catalogue progress and its
allowed lag. This specifies producer and consumer responsibilities; it selects no certificate database, safety-token
ABI, global identity/home sweep or new permission authority. Current native ports do not yet establish the seam.

Omit unsafe engine totals and facet counts over unchecked populations. Approximate or `as_of` labels give no privacy
exemption. Do not substitute zero or returned-row length for an unavailable safe aggregate. No new common list DTO
is selected: owners preserve their envelopes and provide concrete execution through reviewed native contracts.

Suspended valid bearers receive `403 account_suspended` everywhere, including public and unlisted pages. `401` is
for missing, invalid or revoked credentials where authentication is required. Invalid credentials never silently
downgrade to anonymous. Suspended personas have no anonymous-floor exception.

## Freshness

Ordinary catalogue edits become filterable within **60 seconds** in healthy operation. More than **5 minutes of
actual source-to-searchable lag** yields readiness. Measure relay, dependent projection, preparation and searchable
visibility, not engine refresh alone or a document timestamp. Privacy reductions, takedowns, withdrawn consent and
revoked sources apply immediately with no lag allowance. Owner writes are reflected on that owner's next read;
a private prepared result cannot conceal a committed state change behind catalogue freshness.

A public dynamic Collection exposes its last completely published output, never its owner's predicates or facts.
Private changes that do not change that output cannot change public fields or public cursor bases. At terminal
account deletion, only eligible public contributions and completed public generations survive, with de-identified
attribution under [erasure policy](deletion.md) and the relevant owner contract. Private/unlisted data and published
reading logs do not survive. This document does not implement erasure or duplicate its workflow.

## Admission and useful pages

Admit **filter + source + order together**. Grammar admission alone does not admit execution. The responsibility
names are direct catalogue index, direct owner index, prepared public result and prepared owner result. These are
prose names, not new executable discriminants. A composed Zone page combines admitted plans and requires its own
aggregate admission.

A direct plan must have a page-derived bound in actual work units, including backend engine work. Otherwise prepare
an indexed result in bounded background steps retaining settled work. If neither is supported, reject with
`422 unsupported_query` before enumeration. A LIMIT, timeout or small response does not prove bounded engine work.
Do not accept a shape that can only remain permanently preparing.

Prepared state is disposable derived data on existing owner infrastructure. Admission, quota and expiry bound it;
steps retain committed frontier and settled results, and total progress follows relevant finite input and changed
dependencies. No repeated restart from zero, per-built-in witness mirror, unbounded synchronous fanout or reusable
permission result is allowed. Crash/replay and concurrent privacy changes must preserve progress and safety.

A successful list fills the requested page or returns a genuinely exhausted final page. If admitted work cannot
establish either, return explicit preparation/readiness. Readers never walk a chain of short or empty successful
pages over raw nonmatches. Sparse matches behind many nonmatches must produce useful pages after finite preparation
on fixed finite ready input with eventually successful I/O and fair durable progress. Permanent preparing fails.
An essential unknown cannot become false, be skipped forever or manufacture exhaustion.

## Canonical identity and personal references

Use maintained canonical-ID indexes: one public terminal document and unique prepared result rows per generation
and canonical subject. Collection browsing shows one card per canonical subject; editing preserves stored occurrence
IDs, original subject IDs, notes, order and multiplicity. Do not canonicalize after paging in stored-ID order:
`[a,c,z]` with `a → z` would produce `[z,c,z]`, not canonical `[c,z]`.

The shared catalogue identity epoch is pending during serialized durable merge/unmerge/repoint maintenance.
Canonical list reads prepare while pending. Cursors bind the published epoch and restart after changes. At most
**4,096 originals** belong to a group, admitted before effects. Published redirects point directly to active
terminals. There is no request-time 4,096-home sweep, exhaustive alias walk or per-page identity-basis protocol.
Current original and terminal disclosure still applies; a withheld original cannot be laundered through a public
terminal or an arbitrary group representative. Native plans must support list and direct-target disclosure even
when the only eligible original is the last in a large group, through maintained access paths and finite preparation.

Stored personal originals are not rewritten. Canonical personal views select the owner's latest state while keeping
conflict visible, union labels, and keep copies and sessions separate. New writes address current terminals.
[Semantic](../services/kernel/src/semantic/README.md#identity) owns creation and durable identity publication;
this list contract does not invent its native command ABI.

## Built-in presentation and accepted meaning

For an **unmaterialized private** state view, presentation uses the lexicographically smallest **currently supported
immutable release digest containing that state**. This chooses presentation only; digest order means neither
chronology nor compatibility. Discovery unions supported sibling state identities. Each contributing fact keeps its
own accepted pin and meaning. A materialized header's accepted meaning and a public complete generation's accepted
meaning stay fixed; an owner's rename wins. Later support and reader selection use indexed seeks, never a scan of
all supported releases or release history. Native owner facts remain authoritative; no new runtime ABI is selected.

## Zone transport and cursors

`POST /v1/zones/{id}:readPage` preserves its existing optional opaque cursor query parameter and transport:

| Response                                 | Meaning                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `200` common page plus safe Zone shell   | Complete common page; no partial document                                      |
| `202 {next}`                             | Explicit retained preparation with an opaque continuation, `private, no-store` |
| `503` Problem + `Retry-After`, no cursor | Unavailable or no progress                                                     |

Web follows at most four 202 steps per render, then renders a private/no-store preparing page retaining the usable
continuation. A 202 is not an empty successful list and never authorizes endless final-leaf replay. Its progress
refers to retained preparation/current generation, not cached authority, per-leaf verdicts or a client result vector.

Preserve cursor ownership and codecs. POST uses the existing Search cursor profile for every viewer: timed,
confidential, bound to stable operation/route, Zone, viewer and request; mutable bases belong inside the encrypted
position. Valid-shaped unusable progress starts fresh current authorization and returns preparation or a complete
page; invalid body/query and current denial retain their existing outcomes. GET keeps its existing default profile.
Search retains native tuple types, stable binding and principal reauthorization. No schema, status/body or codec
change is authorized here. Current source/fact/grant revocation applies on every continuation.

## Shared acceptance matrix

One shared acceptance matrix varies definitions, visibility and fixtures, rather than surface-specific engines:

| Surface                            | Catalogue filters                                   | Owner predicates                                      | Identity and publication                                             |
| ---------------------------------- | --------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| Curated Collections                | Shared released predicates                          | Owner-only personalized filtering                     | Canonical browsing; occurrence editor preserves duplicates and notes |
| Everything                         | Same predicates, including a library without state  | Own state/labels/progress/holdings in owner partition | Empty entry shells do not invent presence or a state                 |
| State Collections                  | Same predicates over accepted pinned state identity | Owner-only state filtering                            | Supported sibling discovery and fixed accepted meaning               |
| Public/unlisted/private visibility | Same admitted meaning                               | Never borrow curator authority                        | Current source and original/terminal disclosure                      |
| Mounted Zones and TypeLists        | Same predicates intersect eligible source union     | Private personalized view only where admitted         | Canonical cross-page order, complete common page, no union total     |

Required user outcomes are light novels tagged harem; Book wordCount > 1,000,000; and both combined, each in a
public Zone, public Collection, own library and own library with own state. Exactly 1,000,000 and absent word counts
are excluded from the positive threshold. Words and characters are different quantities; incompatible units never
match. Harem/work-form Concepts, genuine word-count data and reviewed source mappings have a separate released-data
producer. Do not invent CURIEs or source keys to imply those prerequisites exist.

Owner-only NOT state X includes subjects with no live state X, including no entry, within the admitted owner
population. Missing catalogue evidence does not become a positive catalogue classification.

Native acceptance must also cover same-statement qualifiers, compact/expanded conformance, healthy/max catalogue
lag, owner read-after-write, foreign fences and targets, sparse matches, finite preparation after crash/replay,
direct-target disclosure, canonical cross-page uniqueness, pending-epoch readiness and current cursor reauthorization.
With the indexer paused, positive, NOT harem, order and count cases remain preparing/readiness until query-level
privacy acknowledgement covers the local reduction **and all affected foreign repair**. Returned-ID checks or
omitted counts alone cannot pass those cases; an ordinary freshness checkpoint cannot certify pending repair.

Preserve the existing unrelated semantic core, graph, history, command and lifecycle acceptance and bounds. These
list decisions do not weaken those native operations. Old proof reports are evidence, not replacement acceptance
gates. Two-release pins, real shared Search runtime, full persona/API/default composition and growth proof remain
required; typed schemas, immutable loaders and cursor-capacity helpers prove only their own boundaries.

## Cost

### Direct and ready-result pages

- Touches: named catalogue/owner index seeks; actual candidates including duplicate, rejected and lookahead rows;
  original/terminal, source and viewer Access points; complete disclosure dependencies; summaries; result/control
  and epoch reads.
- Bound: derive separately per plan in candidates/keys, native points, examined rows including removed rows,
  buffers, statements/connections, bytes, backend engine work and output slots. The whole common page stays at most
  16 distinct reads and 128 TOTAL output slots. Each page or preparation step supplies one INTERNAL cost object
  with named actual candidates (including duplicates/rejects/lookahead), Access/dependency points, backend engine
  work and output-slot counters. These are not public fields or private-count disclosure. The shared harness
  separately captures examined/removed rows, buffers, statements, connections per backend and request/response bytes.
  No executable counter ABI is selected here; native owner specifications must bind actual counters before acceptance.
- Growth check: real API/native captures at three geometric scales, first/deep pages and sparse matches, all owner
  pools, unrelated history/population and alias/duplicate axes. Performance supplies numeric limits and executable
  captures; existing 256-proof tests do not verify this replacement.

### Preparation and index maintenance

- Touches: bounded input/frontier/result writes on existing owner stores; source changes and current foreign
  dependencies; shared outbox/durable work; canonical mapping/index maintenance while the identity epoch is pending.
- Bound: finite total work may follow relevant finite input and changed dependencies. Each step separately admits
  rows, keys, points, bytes, statements and engine operations and retains progress. Charge failures, discarded work
  and rereads. Derived results never store reusable permission. No new scheduler or unbounded synchronous fanout.
- Growth check: three-scale native captures with interruption/replay, concurrent privacy change and terminal
  fencing. Verify complete activation/catch-up and useful pages; permanent preparation is failure.
