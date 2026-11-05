# Native title matching in an owner-scoped Library plan

Source inspection: 2026-10-29, repository revision `4eb32c5de4b4301f7c6e6ab2397eb13aeadbadbd`.
This report is evidence and a recommendation, not adopted semantics, an ABI, DDL or native acceptance.
The fixed product is one header text field plus the shared Boolean filter, whose conditions include scope.
Request text and viewer-self owner facts execute in the native owner plan; public Search receives no personal mirror.
The Collection-condition wire is still being agreed with Semantic and is **not frozen**. No callable helper is assumed.

## Authorities and actual source inventory

Read in full: [owner queries](../library-owner-queries.md), [dynamic Collections](../dynamic-collections.md),
[Collection source](../collection-source.md), [filtered lists](../filtered-lists.md),
[Library and Collections](../library-and-collections.md) and [deletion](../deletion.md).
The owner-index [current](library-owner-index-observation-current.md#physical-minimum-directory-plus-native-truth-indexes)
and [deep](library-owner-index-observation-deep.md) investigations were consulted only for structural-directory constraints.
Their historical source inventories do not establish title capability. No sibling title report was consulted.
Paths below are actual inspected files; `K` means `services/kernel`, `L` means `K/src/library`, `S` means `K/src/semantic`.
Repository source is AGPL-3.0-only, as declared in [package.json](../../package.json).

| Actual source                                                                                                                                                                                                                                                                                                                                                                  | Delivered evidence and limit                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`K/db/library/schema.sql`](../../services/kernel/db/library/schema.sql)                                                                                                                                                                                                                                                                                                       | Entry, copy, session, labels, follows, Collections and occurrences exist. Entry/follow/profile payloads contain no subject title. `collection.title` names the Collection, not its subjects. No owner title-term access path exists.                                         |
| [`L/entry-store.ts`](../../services/kernel/src/library/entry-store.ts), `entry-store-entry-read.sql`, `entry-store-copy-read.sql`                                                                                                                                                                                                                                              | Actual entry/copy points and optional accepted pin writes; `readEntryFact`/`readCopyFact` return stored pins/kind. They do not supply canonical predicate plans or title text.                                                                                               |
| [`L/progress-store.ts`](../../services/kernel/src/library/progress-store.ts), `progress-store-session-read.sql`                                                                                                                                                                                                                                                                | Actual retained sessions and `readSessionFact`, including stored accepting pin. Completion is independent of current entry state.                                                                                                                                            |
| [`L/label-assignment-store.ts`](../../services/kernel/src/library/label-assignment-store.ts), `label-assignment-read.sql`, `label-store.ts`                                                                                                                                                                                                                                    | Independent reserved assignments and current parent truth; label names are personal metadata, outside TITLE matching.                                                                                                                                                        |
| [`L/collection-source-native.ts`](../../services/kernel/src/library/collection-source-native.ts), `collection-source-native-{header,facts,members,probe}.sql`                                                                                                                                                                                                                  | Native stored-header/raw-original ranges and probes; four personal raw drivers. Stored-ID ranges are neither canonical unique pages nor a complete title source.                                                                                                             |
| [`L/collection-source.ts`](../../services/kernel/src/library/collection-source.ts), [`canonical-source-store.ts`](../../services/kernel/src/library/canonical-source-store.ts)                                                                                                                                                                                                 | Exported factories throw `dependency_unavailable`; typed interfaces are not executing owner plans. Existing allowance/home-sweep sketches are superseded, not new budgets.                                                                                                   |
| [`K/db/library/migrations/20261028000646_canonical_collection_sources.sql`](../../services/kernel/db/library/migrations/20261028000646_canonical_collection_sources.sql)                                                                                                                                                                                                       | Applied per-Collection state/fact scaffolding and occurrence tie index; not the adopted ONE owner structural directory. Do not extend its per-fact witness rows into title storage.                                                                                          |
| [`20261027184414_library_profile_pins.sql`](../../services/kernel/db/library/migrations/20261027184414_library_profile_pins.sql), [`20261027202030_profile_vocabulary_storage.sql`](../../services/kernel/db/library/migrations/20261027202030_profile_vocabulary_storage.sql)                                                                                                 | Native accepted profile pins and vocabulary storage; no subject names or title normalization.                                                                                                                                                                                |
| [`20261027190250_personal_labels.sql`](../../services/kernel/db/library/migrations/20261027190250_personal_labels.sql), [`20261027234813_label_reservation_source.sql`](../../services/kernel/db/library/migrations/20261027234813_label_reservation_source.sql)                                                                                                               | Owner/label/subject and reserved-assignment source access; labels need no entry/profile.                                                                                                                                                                                     |
| [`20261028182526_owner_write_sequence.sql`](../../services/kernel/db/library/migrations/20261028182526_owner_write_sequence.sql), [`L/owner-write-sequence.ts`](../../services/kernel/src/library/owner-write-sequence.ts)                                                                                                                                                     | Counter allocator and nullable positive live/archive sequence columns exist. Production `entries.ts` does not call the allocator; set/clear/Undo and NULL cutover remain missing.                                                                                            |
| [`20261028003557_owner_fact_source_hooks.sql`](../../services/kernel/db/library/migrations/20261028003557_owner_fact_source_hooks.sql), [`20261028193813_owner_query_version_coverage.sql`](../../services/kernel/db/library/migrations/20261028193813_owner_query_version_coverage.sql), [`L/owner-fact-version.ts`](../../services/kernel/src/library/owner-fact-version.ts) | All changed native fact/parent rows advance the private broad alarm. Raw session/copy seeks exist. Alarm is not selective dependency coverage, bootstrap, title version, identity publication or permission.                                                                 |
| [`S/item.ts`](../../services/kernel/src/semantic/item.ts), [`write-facts.ts`](../../services/kernel/src/semantic/write-facts.ts), [`K/db/semantic/schema.sql`](../../services/kernel/db/semantic/schema.sql)                                                                                                                                                                   | Native language-tagged `label`, `alias`, `description` assertions/retractions in `semantic.fact`; statements are a different kind. `resolveItem` replays terms; latest label wins per language and aliases add/retract exact values.                                         |
| [`20261025104343_statements.sql`](../../services/kernel/db/semantic/migrations/20261025104343_statements.sql), [`20261025224812_fact_label.sql`](../../services/kernel/db/semantic/migrations/20261025224812_fact_label.sql), [`20261025200114_search_source_counters.sql`](../../services/kernel/db/semantic/migrations/20261025200114_search_source_counters.sql)            | `fact_terms` indexes non-statement histories; `fact_label` indexes assertions, not selected current titles. Slot log positions are bounded at 32 for terms; current-fact counters do not count all historical rows.                                                          |
| [`S/subject.ts`](../../services/kernel/src/semantic/subject.ts), `update-subject-identity.sql`, [`account-agents.ts`](../../services/kernel/src/semantic/account-agents.ts), `account-agent-sync-label.sql`, [`20261027000200_account_agent_label_erasure.sql`](../../services/kernel/db/semantic/migrations/20261027000200_account_agent_label_erasure.sql)                   | Actual creation and `updateSubjectIdentity` label append; rename checks slot/history and 512-counter capacity. `ensureAccountAgent` instead replaces/erases the derived account node's label without retained name history; a redirected agent does not rename the survivor. |
| [`S/search-source.ts`](../../services/kernel/src/semantic/search-source.ts), `search-source-{subjects,facts,adoptions,statements,releases,position}.sql`                                                                                                                                                                                                                       | Delivered public-source reader: term history replay, compact/expanded selected statement resolution, immutable release interpretation, redirect/visibility/security revision and source position. A bounded ID count does not bound its history work.                        |
| [`S/summaries.ts`](../../services/kernel/src/semantic/summaries.ts), [`summaries-read.sql`](../../services/kernel/src/semantic/summaries-read.sql), `language.ts`                                                                                                                                                                                                              | Authorized batched display summaries choose ONE label by language preference/original language. They omit aliases; selected image/representative-edition/language slots are not a complete searchable title projection.                                                      |
| [`S/fences.ts`](../../services/kernel/src/semantic/fences.ts), `statement-disclosure.ts`, `moderation.ts`, `candidates.ts`                                                                                                                                                                                                                                                     | Actual source-tuple, candidate, disclosure/retraction and moderation hooks. `subjectSource` optionally fences statement entries; its term replay is not equivalent proof of complete title provenance/withdrawal coverage.                                                   |
| [`S/public-filter-source-contract.md`](../../services/kernel/src/semantic/public-filter-source-contract.md), [`identity-epoch-contract.md`](../../services/kernel/src/semantic/identity-epoch-contract.md)                                                                                                                                                                     | Required privacy observations/repair ACK and scoped identity bindings remain producer obligations. Point Access and existing subject snapshots do not implement Source2a/STORE/mapping/custody.                                                                              |
| [`packages/filter/src/filter.ts`](../../packages/filter/src/filter.ts), [`owner-filter.ts`](../../packages/filter/src/owner-filter.ts)                                                                                                                                                                                                                                         | Actual closed `and/or/not/type/statement/saved/owner` AST and structural admission. `owner:true` enables structure only. No Collection leaf or viewer-self SQL executor is delivered here.                                                                                   |
| [`K/src/search/http/routes.ts`](../../services/kernel/src/search/http/routes.ts), [`service.ts`](../../services/kernel/src/search/service.ts)                                                                                                                                                                                                                                  | Actual `POST /v1/subjects:search` body has optional `text`, `filter`, `sort`, `limit`, cursor and display options. Public admission does not enable owner execution.                                                                                                         |
| [`K/src/search/text.ts`](../../services/kernel/src/search/text.ts), [`document.ts`](../../services/kernel/src/search/document.ts), [`K/db/search/indices/subjects.json`](../../services/kernel/db/search/indices/subjects.json)                                                                                                                                                | Delivered parser/compiler, names payload and analyzer definition, detailed below. No PostgreSQL analyzer-equivalence implementation is present.                                                                                                                              |
| [`L/collection-routes.ts`](../../services/kernel/src/library/collection-routes.ts), [`collection-reads.ts`](../../services/kernel/src/library/collection-reads.ts), `views.ts`                                                                                                                                                                                                 | Current members GET accepts view/cursor/limit and reads curated ordinal occurrences before subject checks. It is not the specified filtered/title/dynamic native members service.                                                                                            |

## Title meaning and analyzer boundary

The existing Search `names` truth is every current label and alias value across languages, deduplicated by exact string.
There is no generic separately selected `title` column: arbitrary `schema:name` or other statement values are not added
by `document.ts` to `names`. Descriptions join names only in public `search_text` through `copy_to`.
Recommend TITLE use those complete authorized label/alias forms of the current terminal, without descriptions,
personal notes, progress values or label-definition names. Locale preference affects display, not searchable coverage.
This deliberately required TITLE field boundary differs from public Search's broader field; it does not license token changes.
Do not assume an editor's privately inspectable statement becomes public title truth or that a visible terminal grants original access.
Original support and terminal title eligibility are separate dependencies; hidden original names cannot supply matching evidence.
The precise authorized title/provenance producer, including term assertion source and withdrawal, still needs Semantic specification.
Term replay supports retractions, but that is not evidence of a delivered general alias-edit/retraction command.

`parseText` implements implicit AND, `|` OR, unary `-`, parentheses, quoted phrases and its fixed escape set.
It limits UTF-8 bytes to 512, depth to 4, leaves to 64 and phrase tokens to 32; CJK characters count separately.
`compileText` uses `match(operator:and)` for a term leaf and `match_phrase` for a phrase, with Boolean composition.
A term may analyze into several tokens; phrase matching needs positions, token gaps and separate title-value boundaries.
Reuse this parser/AST, not `websearch_to_tsquery`, regular expressions, substring search or another Boolean syntax.
Public admission rejects wholly negative requests unless another admitted positive filter anchors them (`admitQuery`).
In owner plans the scope is an anchor, but its treatment for negative-only admission must be specified, not assumed delivered.
Absent `text` means scope plus owner/shared conditions. Actual Search rejects `text:""` and whitespace-only text;
recommend the header omit empty text, preserving current parser behavior rather than silently treating invalid text as match-all.

The configured chain is ICU NFKC casefold → standard tokenizer → Traditional-to-Simplified/Hiragana-to-Katakana
transform → CJK bigrams → configured stop filter. This is neither PostgreSQL collation nor ordinary lowercasing.
A significant source detail: mapping spells stopwords `_cjk_`, but pinned OpenSearch `Analysis.NAMED_STOP_WORDS`
contains no such named set; `resolveNamedWords` retains unknown names literally. Do not infer English stop removal
from the analyzer's name. The actual factory uses that resolver; this is source-derived, not a live analyzer result.
Zero-token leaves compile to no-match under OpenSearch defaults; their negations must complement that result only
inside the authorized finite population. Empty input, zero-token input and unknown/unready title evidence are different.

Concrete parity controls, inferred from the configured chain and primary source rather than executed here:

| Input/control                                                                    | Consequence for an owner implementation                                                                                                                                |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title `ＣＡＴ`, query `cat`; title `學園`, query `学园`; Hiragana/Katakana pairs | NFKC casefold and the configured script transforms can make these match. `lower()`/`ILIKE`/default PG text search do not reproduce the chain.                          |
| Title `rats`, query `rat`                                                        | No English stemmer is configured in Search; PostgreSQL `english` stemming would introduce a false match.                                                               |
| Title `東京大学`, query `東京` versus query `京`                                 | Overlapping bigrams and isolated-unigram handling matter; substring matching can match `京` where the indexed multi-character token stream has no isolated `京` token. |
| Title `blue red`, query `"red blue"`; title values `red` and `blue`              | Phrase order/positions matter; concatenating distinct alternate/localized values can create a false phrase. Plain lexeme sets are insufficient.                        |
| Title `the`, query `the`; punctuation-only query                                 | Do not assume `_cjk_` expands to English stopwords. Zero-token behavior follows actual analysis, not whitespace heuristics.                                            |
| `foo                                                                             | -bar`, `-(foo                                                                                                                                                          | "bar baz")`, canonically equivalent Unicode and casefold expansions | Preserve parser Boolean structure, completeness under negation and analyzer version; a current-locale-only list omits valid names. |

PostgreSQL `simple`/`english`, trigram similarity and ICU collation therefore cannot establish exact public token semantics.
The smallest semantic choice required is explicit ownership of a versioned TITLE analyzer/evaluator compatible with the
current Search chain, including term boundaries, phrases, zero tokens and value gaps, executed in the existing process.
Recommendation: preserve Search analysis meaning; require its bounded query-analysis and positional-title producer SPEC
before implementation. This is not a claim that a compatible library is already installed or PostgreSQL has that analyzer.
If parity cannot be supplied in this stack, the text owners must adopt an explicit narrow semantic difference with the
counterexamples above; neither a second engine nor an undocumented PG approximation is an admissible research conclusion.
Relevance also needs an explicit native order definition: OpenSearch BM25 depends on corpus statistics; PG rank is not equivalent.
Retained ID/name ordering can avoid scoring only when that order is actually admitted, never by changing the request silently.
Search defaults to relevance with text and name otherwise; `name_sort` selects the first language-sorted label,
NFKC-casefolds it as a keyword and ties by ID. A PostgreSQL locale collation is not that order; collections/rating add foreign dependencies.

## Smallest feasible owner-side choice

Keep ONE owner candidate/support directory over native facts, shared across built-ins and admitted queries.
Canonical candidates and original/scope presence/extrema are structural; a million same-original sessions do not make
one million directory witnesses. Native accepted profile/lifecycle/kind/status indexes supply exact owner predicates.
State selects highest LIVE `owner_write_seq` before testing values. Label requires an effective assignment/live parent;
session and holding use stored accepted pins, and both holding qualifiers must match the SAME copy.
Everything is state/effective-label/retained-session/holding union; cleared shells, follows, reactions and occurrences alone do not qualify.
Collection scope can include manual-only subjects absent Everything. Its original membership input feeds this same
structural access machinery; a Collection is not implicitly intersected with presence. Curated duplicates collapse for
search, while immutable original occurrence IDs/notes/order remain in the editor. No persistent per-Collection member cache is proposed.
Public/nonowner dynamic scope consumes only completed published membership, never a copied private definition or fresh curator facts.
Caller owner leaves always bind the current authenticated principal, including delegation, never an account operand or curator inference.

Compare these options only as potential implementation designs:

| Option                                                                | Physical benefit                                                                                                                                                                                           | Maintenance/correctness cost and recommendation                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner-local derived normalized positional titles plus access metadata | Reuses title analysis across admitted queries; owner-prefixed term/order access can accelerate selective positive leaves. Copies public title text/terms privately, not personal facts into public Search. | Needs title-source subscriptions, inverse owner repair and source/format/lifetime fences. Arbitrary AND/OR/NOT, phrase rechecks and sort remain potentially unbounded. Do not promise all direct pages from GIN.                        |
| Retained query preparation over finite directory candidates           | No standing per-owner catalogue/title copy. Fetch complete authorized titles in bounded batches, evaluate text and actual shared owner/Collection conditions, retain unique ordered result rows.           | Requires bounded native title batches, complete source/change dependencies and the compatible evaluator; total build follows relevant finite input. Recommended minimum because general Boolean/sparse shapes already need preparation. |
| Combination in the ONE directory                                      | A disposable candidate-attached positional derivative can amortize repeated title reads/analysis; the same retained planner handles hard shapes.                                                           | Add only after measured repeated-read benefit. Never create another per-built-in/per-session/per-copy population or declare derivative payload native canonical truth.                                                                  |

Recommendation is retained preparation first, with direct plans only for separately proven bounded shapes. It composes
shared leaves and scope without public top-N intersection, private Search documents or a request population scan.
First reuse a paged `fact_terms` range plus current term replay under a complete authorized source SPEC; do not require
a new projection merely to avoid statement history. A current selected-title projection at the subject home is optional
native derived access if the physical proof requires it, not permission or a catalogue replicated into every owner partition.
A read batches full keys by row kind/backend in RR, releases owner/source connections before another checkout, then
conditionally settles owner-side work against current observations. Never hold the owner transaction across title reads.
No per-subject remote query loop, cross-partition SQL join, new queue/process or engine is included.

## Physical cost derivation and lifetime

Let `N` be total catalogue/fact/history inputs, `O` distinct candidates of the actual owner/source, `D` duplicate
occurrences/aliases/facts, `q` fixed query bytes/terms, `s` page slots and `R` composed reads. Let `A` be distinct
original/scope supports, `v(c)` title forms, `b(c)` complete positional-title bytes and `u(c)` distinct title lexemes.
These are independent axes: `O` is not bounded by 4,096; `D` can grow with `O` fixed; titles can have many owners.
Current inputs have 512-fact admission and 250-JS-code-unit forms, aliases ≤32/language (`packages/definitions/src/validate.ts`).
Term slots have ≤32 log entries; delivered identity edits additionally charge appended labels to the 512 counter.
Do not call all term history unbounded, or confuse 512 current facts with 512 physical rows: migrations count latest terms,
and `search-source-facts.sql` also reads statement history. Page exact title/provenance ranges and charge their actual rows/bytes.

Directory cardinality is `O + A` structural rows plus needed inverse/order indexes, not `O + D` exact-fact copies.
For the optional derivative let `C≤O` be covered candidates: one positional payload per `(owner,canonical candidate)`
and one posting per distinct `(owner,candidate,lexeme)` gives exactly `C` payloads and `Σu(c)` postings over that set.
There are `Σv(c)` logical title forms, with each public form copied once per subscribed owner, not per occurrence or query.
Payload data bytes are exactly `Σb(c)` for that encoding, plus keys/versions; posting lexeme bytes are `ΣΣutf8(term)`.
For a transparent size floor, route+owner UUID+candidate UUID is 36 bytes; a minimal heap row adds a normally 24-byte
aligned tuple header and 4-byte page item, before payload varlena headers/alignment/null bitmap and source/format keys.
Thus `C` uncompressed payload rows already cost at least `64C + Σb(c)` bytes before those additions and indexes;
postings repeat that key floor plus term/position representation. This is a lower bound, not measured allocation or adopted DDL.
Exact physical bytes are the sum of aligned encoded heap tuples, page items, TOAST copies and every index tuple/page;
without selected packing/fillfactor/versions no honest fixed byte number exists. Include MVCC old copies, WAL, abandoned
builds and reclamation lag. A native SPEC must instantiate these expressions, not quote compressed text length as storage.
Across accounts with owner counts `h(c)`, standing copied title bytes are `Σ h(c)b(c)`, never a universal `owners × N` cache.
Retained-only storage instead has up to the existing 32 live definitions/owner, their dependencies/frontiers and actual
unique result rows per retained generation; title batches can be discarded after settling. No standing `Σh(c)b(c)` payload is required.

Initial directory bootstrap reads native owner inputs in bounded phases: total `O(owner facts + D + A)`, not request work.
Retained title preparation visits each relevant candidate/title input once per build, plus one interrupted step replay;
total `O(O + A + title bytes + needed source history/projection work)` with fixed `q`, and ordered result insertion costs
indexed `log(result size)` per write. It need not sort all matches during a request. Result size itself is charged storage.
Projection insertion/removal changes only addressed title forms/postings and indexed structural scopes; repair removes
old title/order keys as well as adding new ones. A title with `h` owners requires total `O(h)` affected owner work,
not one synchronous transaction: retain source→consumer registrations, page owner locators and coalesce versioned work.
An account with many title forms/support scopes also needs bounded within-account repair; one owner locator is not the whole job.
Reduction first invalidates dependent reads at the authoritative source commit. Repair may lag; disclosure may not.

Direct reads must fit [existing ceilings](../filtered-lists.md#cost): `c≤min(600,6s+3)`, at most three owner seeks,
`64+16c` examined PG rows, six shared blocks per budgeted row, `16+8c` points and three refill rounds counted inclusively.
Request/response ceilings remain `64KiB+1KiB×c` / `16KiB+4KiB×c`, including source-title traffic and engine work.
A one-read backend has ≤12 statements; composition has ≤`8+4R`, one connection/backend and the existing 16-read/128-slot limit.
A title GIN bitmap with a common term, anti-term or arbitrary order can visit/sort `O(O)` matches despite LIMIT;
PG source expressly uses full GIN search for no required positive term and phrase queries can require heap rechecks.
Consequently such shapes prepare. Current prepared reads seek ordered unique rows, ≤`2s+2` candidates and two index reads,
then perform current shared source/original/terminal/safety/summaries work within the SAME read ceilings.
Sparse authorization/reductions exceeding those bounds repair/preparing, never an endless short/empty success chain.

Preparation inherits [filtered-list budgets](../filtered-lists.md#cost) and the stronger applicable
[Kernel job limits](../../services/kernel/README.md#bounded-job-steps): 100 RAW rows/page, 100 pages/segment,
5,000 ms command deadline, eight-scalar/2,048-byte frontier and 4,096-byte workflow arguments/results.
Raw title/history/provenance keys, duplicates, rejected inputs and lookahead all count; fewer candidates may fit a byte limit.
Kernel RAW100 is durable-job authority only, neither a universal public-page rule nor a new owner allowance.
Share quota 32 live owner results and 24h idle expiry with existing preparation; do not allocate separate title quota.
Preparation also inherits 16 statements/backend, eight Access/dependency points/input and 4MiB response, not extra title reads.
Per-attempt deadlines, failed statements/reads and discarded work are charged. Core contention retry remains deadline-bounded;
DBOS command-step retry policy is existing infrastructure, not a fresh unlimited title retry loop or renewed request deadline.
Cursor cost is bounded decode/binding plus current scoped source/result/dependency observations and keyset seek, never OFFSET,
seen-ID arrays, all aliases/homes or a global revision vector. A second read inside an old RR snapshot cannot detect a later write.

Derivative lifetime, if later justified, begins only with covered native owner/source support or a live retained build.
Last support/result expiry removes its title payload and inverse subscriptions boundedly; it is not kept for all public titles.
Rename/retraction/withhold/reveal, source-tuple/security/version changes, repoint/unmerge, release/meaning/analyzer changes,
excluded and order-only dependencies invalidate old use. Retain old/new repair locators until all consumers settle/expire.
Owner mutations affect the next read; ordinary title edits follow the existing 60s/5min freshness authority, reductions immediately.
Complete original AND terminal admission and title-source authority apply before evaluation and again before disclosure.
The private owner↔title relation, fact keys, query AST and registrations never enter public logs, keys, counts or Search documents.

## Adversarial schedules and required native cuts

| Schedule                                                                          | Required settled outcome and bounded mechanism                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only `s+1` text matches occur late in huge owner history                          | No request scan or public top-N truncation; retained finite candidate/title frontier reaches a useful full/final page. Work follows native candidates/support, not session multiplicity on every query.                           |
| Manual-only Collection subject and `[x,y,x]` occurrences                          | Collection condition includes manual-only `x` without presence; search emits one canonical `x`, editor retains both occurrences. Scope changes invalidate affected negative/order branches too.                                   |
| Label-only subject; completed session after state clear                           | Both remain in Everything; no fabricated entry/default state. `NOT state` may match, while actual own completed-session exclusion still rejects. Bob's facts are never consulted.                                                 |
| CJK, phrase, Unicode and negation controls above                                  | Positional compatible analysis across every authorized label/alias; unknown source coverage cannot turn into a negative match. Separate forms cannot manufacture a phrase.                                                        |
| Withheld original and visible terminal share title                                | Terminal title equality supplies no original authority. Another eligible original can support the card; hidden original title/facts cannot affect match, NOT or order. No exhaustive alias walk.                                  |
| Rename/withhold/reveal behind a prepared frontier                                 | Atomically record old/new dependencies and invalidate relevant result use before repair. Indexed behind-frontier repair handles newly matching/removed/excluded rows; candidate checks alone cannot protect NOT.                  |
| Source version, consent, selected candidate or release changes                    | Observe actual title/selected-source meaning and foreign dependencies, including removals and order-only inputs. Missing producer evidence is readiness, not stale success or complete absence.                                   |
| Account erased at T while title work is queued                                    | Every read/apply rejects immediately; late work cannot recreate payload, directory, head or subscription. Purge abandoned/building generations and shared copies under actual custody.                                            |
| One title changes for many owners                                                 | One source invalidation plus bounded reverse-registration fanout; each account resumes affected work, unrelated owner queries settle. No public owner-holder directory or synchronous all-owner update.                           |
| Crash/replay/bootstrap or cursor reuse                                            | Page effects and frontier commit together; covered-side writers apply old/new deltas once. Replay rereads ≤one step; stale completion cannot activate over a newer dependency cut. Changed bases reject/restart cursors.          |
| Continuous disjoint identity jobs                                                 | SCOPED/PARTITIONED/CONCURRENT observations cover actual source closure, including excluded/order originals and terminal. An unchanged finite owner source settles; no global active marker, guessed capacity P or universal gate. |
| `(Collection condition OR owner label) AND NOT other scope` with concealed source | Admission/authorization checks every referenced source before Boolean execution; OR/NOT cannot turn concealed-source denial into an existence oracle or borrow fresh curator-private facts.                                       |

Before costly runtime, split native specifications/producers into small independently reviewable cuts:

1. Semantic/Search agree TITLE source and versioned analysis conformance, including the `_cjk_` source discrepancy,
   zero-token/negative admission, current labels/aliases, source provenance, array gaps and native sort semantics.
2. Semantic freezes Collection-condition grammar/authorization/dependency expansion in the existing shared AST;
   Commerce binds actual viewer-self owner leaves, population and source scopes. No guessed public dynamic definition wire.
3. Complete the existing owner structural-directory/family-writer/native-index SPEC, sequence set/clear/Undo cutover,
   live-label parents and retained session/copy support. Keep exact facts/pins native and bootstrap writer-aware.
4. Semantic supplies bounded complete authorized current-title batches/projection and change/reduction observations at
   actual title/source writers, with inverse routing and repair ACK, including excluded/order/original/terminal dependencies.
   Bind `writeSubject`, `updateSubjectIdentity`, `ensureAccountAgent` label sync, moderation, candidate/disclosure/bulk
   reductions, `takedownSourceFence`, Collection publication/removal and account-agent unlink/erasure; events alone are late.
5. Bind retained owner preparation to delivered Core `command/operational.ts` and `work/client.ts` atomic same-client
   DBOS intent, current-T finalization, quota/expiry, selective repair and settled full/final output; factories remain unavailable meanwhile.
6. Bind scoped native identity observations and ALL canonical directory/title/result custody to the existing
   `library-private-follow-counts` participant. Follow-only ACK is insufficient; no third participant or false NoData.
7. Add exact title-derived records/keys to Library [A5](../../services/kernel/src/library/README.md#retention-inventory).
   Accounts shared-history owns durable work/receipts/events: declare account roles/scopes and physical artifact locators
   transactionally; work carries only identifiers/minimal locators, never title payload or private query AST. Cover prior
   generations and account-agent label erasure; finish or transfer native obligations before supported DBOS deletion.
8. Freeze native outcome/growth specifications for every schedule above and inclusive physical/read/maintenance costs;
   only subsequent authorized implementation establishes runtime evidence. This report creates no test or executable gate.

The shared source pattern is separation of native meaning, derived access and current disclosure: positional analysis
is more than collation, an index does not bound every Boolean/order plan, and retained results never grant permission.
The smallest adoption is a compatible TITLE source/evaluator plus retained owner planning on the ONE directory;
standing owner title derivatives are optional amortization requiring their own lifetime and high-fanout proof.
Report existence proves prose delivery only. No runtime, DB, engine/provider probes, builds or native acceptance were run.

## External primary-source record

Existing clones were read only under `/home/edge/projects/rezics/rezics-next/.reference/`; no source was installed or executed.
`search-canonical-coverage/postgres`, commit `227de22095c8101905ce41e1ebf425239feed079`, PostgreSQL License (`COPYRIGHT`):
[`src/backend/utils/adt/tsginidx.c`](https://github.com/postgres/postgres/blob/227de22095c8101905ce41e1ebf425239feed079/src/backend/utils/adt/tsginidx.c)
proves full-index negative search and positional recheck; [`doc/src/sgml/indices.sgml`](https://github.com/postgres/postgres/blob/227de22095c8101905ce41e1ebf425239feed079/doc/src/sgml/indices.sgml)
explains ordered B-tree versus scan/sort. Official [text controls](https://www.postgresql.org/docs/18/textsearch-controls.html),
[index types](https://www.postgresql.org/docs/18/textsearch-indexes.html) and [trigrams](https://www.postgresql.org/docs/18/pgtrgm.html)
corroborate lexeme/dictionary, recheck and similarity differences; none promises owner-page boundedness.
`search-canonical-coverage/opensearch`, commit `4ee42a94e87f66fbf1e62a9871b1b87f91e02472`, Apache-2.0 (`LICENSE.txt`):
[`CJKBigramFilterFactory.java`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/modules/analysis-common/src/main/java/org/opensearch/analysis/common/CJKBigramFilterFactory.java),
`plugins/analysis-icu/src/main/java/org/opensearch/index/analysis/{IcuNormalizerCharFilterFactory,IcuTransformTokenFilterFactory}.java`
and [`Analysis.java`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/index/analysis/Analysis.java)
were inspected alongside `server/src/main/java/org/opensearch/index/{analysis/StopTokenFilterFactory,search/MatchQuery,mapper/TextFieldMapper}.java`.
These locate normalization/transliteration delegation, actual stopword resolution, phrase construction and zero-token defaults.
Official [CJK bigram documentation](https://docs.opensearch.org/3.0/analyzers/token-filters/cjk-bigram/) corroborates script/unigram behavior;
the pinned source controls where documentation or analyzer names are insufficient. Recommendations are deductions for this repository,
not a proposal to copy external implementations or their passages.
