# Native owner TITLE matching with shared scope conditions

Source-only evidence, 2026-10-29, repository revision `ca7c319edefd8d8a272b8fb51c6d57eff5fa2383`.
This recommends a mechanism; it adopts no ABI, schema, numeric allowance or product decision.
No runtime, database, engine, provider, build or acceptance execution was performed. Report existence proves no native result.
The sibling title investigation was not read. The adopted owner-index pair was consulted only for structural constraints.
Repository sources are under the root [AGPL licence](../../LICENSE); external sources and licences are recorded below.

## Recommendation within the fixed product

Keep one header text field. Admit request text, expanded shared filter, Library/Collection population and order together.
Run TITLE evaluation and actual viewer-self owner leaves in the private native owner plan, never public-top-N intersection.
The smallest general solution is retained query preparation over the ONE structural owner directory and native scope sources,
with bounded authorized complete title reads, owner-local text evaluation and unique ordered query results.
Do not initially maintain reusable title payload/postings in every owner's directory: preparation needs no such global duplicate.
Direct seeks remain an optimization for demonstrably bounded shapes, not the completion strategy for arbitrary Boolean text.
This requires missing native producers and an explicit analyzer conformance specification before implementation or activation.

The full owning documents inspected are [owner queries](../library-owner-queries.md), [dynamic Collections](../dynamic-collections.md),
[Collection source](../collection-source.md), [filtered lists](../filtered-lists.md), [Library](../library-and-collections.md)
and [deletion](../deletion.md). Their membership, privacy, preparation, identity and cost requirements remain authoritative.
Scope is a shared condition; its exact Collection wire and complement/population admission are **not yet frozen** with Semantic.
The notation below is descriptive, never JSON or a proposed callable helper. No private dynamic definition goes on public wire.

## Exact inspected native inventory and delivery boundaries

Paths in this table are relative to `services/kernel/` unless prefixed `packages/`.
Unprefixed SQL/migration siblings share the first directory; listed storage does not imply related runtime is delivered.

| Source | Actual evidence and limitation |
| --- | --- |
| `packages/filter/src/{index.ts,filter.ts,owner-filter.ts}` | Delivered `FilterDocument`, `OwnerLeaf`, `parseFilter`, `admitFilter`, `walkFilter`: AND/OR/NOT, saved expansion, type/statement and closed owner leaves. `owner:true` is structural opt-in, not private authorization or execution. No Collection leaf exists in this inspected grammar. |
| `src/search/text.ts` | Delivered `parseText`, `positiveText`, `compileText`; syntax and OpenSearch clauses, not an owner text matcher or analyzer. |
| `src/search/{service.ts,filter.ts,query.ts,http/routes.ts}` | POST subject search has separate `text`, `filter`, `sort`, limit/cursor and projection options. Service uses default filter admission; catalogue compiler explicitly rejects owner nodes. Text compiles against `search_text`. No private owner planner is wired here. |
| `db/search/indices/subjects.json`, `db/search/opensearch/Dockerfile`, `src/search/document.ts` | Public `names` is deduplicated labels plus aliases; descriptions also copy into `search_text`. Analyzer is `cjk_bigram_v2`; image pins OpenSearch 3.9.0 plus ICU. Name ordering uses a separate normalized key; relevance uses engine score. These are public documents, not private candidate storage. |
| `db/library/schema.sql` | `entry`, `copy`, `progress_session`, `follow`, profile pins, labels and occurrences contain no subject title. Collection `title` and `personal_label.normalized_name` name those resources, not the subject. There is no owner TITLE index or adopted shared directory table. |
| `db/library/migrations/20261027184414_library_profile_pins.sql`, `20261027202030_profile_vocabulary_storage.sql` | Nullable accepted pins and conditional vocabulary storage exist. They do not complete production profile acceptance or canonical predicate indexes. |
| `src/library/{entry-store.ts,progress-store.ts}` and `entry-store-{entry-read,entry-update,copy-read}.sql`, `progress-store-session-read.sql` | Actual `readEntryFact`, `readCopyFact`, `readSessionFact` expose stored pins; adapters accept entry/session pins and copy pin/kind. Entry adapter still has fixed state vocabulary; SQL update does not allocate/write `owner_write_seq`. Storage is narrower than a native shared owner plan. |
| `src/library/{entries.ts,owner-write-sequence.ts,owner-fact-version.ts}`, `db/library/migrations/20261028182526_owner_write_sequence.sql` | Bigint allocator, owner counter and nullable positive live/archive sequence columns exist. Native set/clear does not call the allocator; authoritative NULL cutover and complete Undo integration remain pending. |
| `db/library/migrations/20261028003557_owner_fact_source_hooks.sql`, `20261028193813_owner_query_version_coverage.sql` | Raw copy/session indexes and fact-head hooks exist; later migration covers every actual changed row in all five UPDATE families. Broad `readOwnerFactVersion` is a same-snapshot alarm, not selective invalidation, bootstrap or complete source/title coverage. |
| `src/library/{label-store.ts,label-assignment-store.ts}`, `label-assignment-{read,parents,reservations}.sql` | Actual assignment/reservation and live-parent truth; effective label membership requires both. Label text is not subject TITLE. |
| `src/library/collection-source-native.ts`, `collection-source-native-{header,members,facts,probe}.sql` | Stored-header authorization, raw occurrence/fact ranges and original probes exist. Fact drivers cover entry/copy/session/reserved assignment. They do not establish canonical full pages, headerless built-ins or completed public dynamic output. |
| `src/library/{collection-source.ts,canonical-source-store.ts}`, `db/library/migrations/20261028000646_canonical_collection_sources.sql` | Factories are throwing scaffolding. Per-header `canonical_source_state/fact` DDL and occurrence index exist; do not expand its copied witnesses into the new owner directory. Old home-sweep allowances are superseded. |
| `src/library/{collection-routes.ts,collection-reads.ts,collection-model.ts}` | Current members GET schema has view/cursor/limit, not text/filter/sort; stored curated rows and ordinal paging remain. The required common filtered native surface is not delivered by these schemas. |
| `src/library/{builtin-identity.ts,builtin-reference-store.ts,preparation-native-reader.ts}` | Everything/state identities and entry-based reference support, plus receipt-checked initial type-preparation provenance, are primitives. They are not all-family candidates, title preparation or complete current publication. |
| `src/semantic/{item.ts,write-facts.ts,insert-facts.sql,search-source.ts}` | Native term truth is language-tagged labels, aliases and descriptions in the fact log. Item/search readers fold assert/retract history. `writeFacts` bounds one submitted fact batch, not lifetime history or total title-read work. |
| `src/semantic/search-source-{subjects,facts,adoptions,statements,releases,position}.sql` | Real RR snapshot reads visibility/redirect/security/current release; term history and compact/expanded selected statements; Global replace adoption, rank, hidden/disclosure/retraction filtering. This bulk public source is not a bounded authorized complete owner title port. |
| `src/semantic/{summaries.ts,summaries-read.sql,language.ts,read-labels.sql}` | Authorized `readSubjectSummaries` returns one chosen display label, type and cover. It omits aliases; label SQL folds history. `read-labels.sql` selects latest assertions without the summary reader's latest-operation handling. Neither establishes complete searchable forms or bounded history cost. |
| `src/semantic/{fences.ts,statement-disclosure.ts,public-filter-source-contract.ts,public-filter-source-contract.md}` | Tuple-fence checks and real consent/retraction commands exist. Complete selected-public projections, native privacy log/behind-home observation/repair ACK are future contracts. Existing events/security revisions do not implement query-wide exclusion/order safety. |
| `src/semantic/{identity-epoch-contract.ts,identity-epoch-contract.md}` | Explicit missing STORE/mapping/coordinator producers; types do not supply native epoch maintenance or directory rekey custody. |
| `src/command/operational.ts`, `src/work/client.ts`, `src/library/README.md#retention-inventory` | Actual event-free fenced operational executor and same-client transactional DBOS enqueue exist. Library consumer, selective preparation, title custody and whole-role A5 cleanup are still required. |

## Title truth, authorization and text meaning

Existing searchable name forms are **all current native label languages and all current alias languages/values**.
`semantic/search-source.ts:termValues` and `search/document.ts` prove that set; locale preference selects display only.
Descriptions are existing public fulltext but are outside this TITLE requirement. A description-only hit must not match here.
No inspected projection promotes arbitrary `schema:name`, translated-title statements, edition labels, private notes,
progress locators or personal-label names into `names`; do not silently add them as alternate title authority.
Selected statement readers still matter for catalogue conditions, source provenance, original language and order dependencies.
Labels/aliases are term facts, not automatically candidates selected by the statement-adoption machinery.
The missing title producer must establish their actual authoritative source/withdrawal provenance; statement hooks alone are insufficient.

Recommended TITLE field meaning is the existing public **name forms**, analyzed with the current text profile, excluding descriptions.
This is a field restriction required by the product, not byte-for-byte equality to public `search_text` membership.
Only forms currently authorized by native source, original AND terminal checks may influence matching, exclusion or order.
Do not union withheld original labels into a visible terminal or treat `subjectSource` as actor-authorized because it returns strings.
Whether any private source-backed title is admissible must come from Semantic's native disclosure producer, not owner cache possession.

Reuse `parseText`: whitespace AND, `|` OR, unary `-`, groups, quoted phrases and its closed escape rules.
Limits are 512 UTF-8 bytes, depth 4, 64 leaves, 32 phrase tokens. These differ from shared filter's 32-leaf limit.
Parser token counting is admission only; it is not the standard tokenizer/CJK analyzer. Never parse again as SQL query syntax.
Omitted text means scope plus owner/catalogue conditions only. Current `parseText('')` and whitespace-only input reject;
the header must omit an empty text value rather than invent an empty phrase, regex or match-all text compiler branch.
`positiveText` is not simply “any positive anywhere”: every OR branch needs one. Public admission alternatively accepts
a positive shared filter. Owner scoped negative-only text therefore needs explicit combined native admission, not a bypass.
Complete authorized empty title forms can support text nonmatch; unavailable/partial forms cannot become true under negation.

The mapping pipeline is ICU NFKC casefold → standard tokenizer → Traditional-to-Simplified/Hiragana-to-Katakana →
CJK bigrams → CJK stopwords. Term clauses require all analyzed tokens; phrases require positional match, including gaps.
Different label/alias values are separate field values: term tokens can be distributed across them, but a zero-slop phrase
must not be manufactured by concatenating adjacent aliases. Preserve multi-value positions and stopword behavior.
Zero-token clauses, punctuation, Unicode version and token-length behavior also need conformance; parser acceptance is not matching.

Concrete counterexamples to stock PostgreSQL `simple`/`english`, `ILIKE` or lowercase/substring substitution:

| Input/title case | Required distinction |
| --- | --- |
| Query `图书`, title `圖書`; query `カナ`, title `かな` | Current transliteration can unify them; PostgreSQL lowercase/ordinary collation does not perform those transforms. |
| Query `ABC`, title `ＡＢＣ`; query `strasse`, title `Straße` | NFKC casefold compatibility and expansion exceed ordinary lowercase and locale-dependent comparisons. |
| Query `東京`, title `東京都` | Current CJK bigrams can match the pair inside the run; PostgreSQL default word parsing is not the same bigram stream. |
| Query `rat`, title `rats` | PostgreSQL English stemming can match; this mapping has no English stemmer. |
| Query `"red blue"`, values `red` and `blue` separately | Naive concatenation creates a false phrase; positional field-value boundaries must survive. |
| Query `red -blue`, or `(red|green) -"blue moon"` | Negation/phrase evaluation needs complete analyzed forms and the existing AST, not a substring shortcut. |

These are source-derived conformance cases, not observed engine outputs. PostgreSQL is not inherently incapable of equivalent
evaluation, but its built-in text configuration and collation are not an implementation of this mapping.
Smallest semantic cut: specify TITLE's form set, pinned analyzer/version, multi-value and negative/zero-token semantics;
then supply a compatible bounded in-process evaluator on existing owner workers. No such evaluator is delivered here.
Preserve exact analysis unless the owning specification explicitly adopts a different owner text profile with these differences.
Do not quietly choose PostgreSQL semantics. Public relevance/BM25 statistics and `name_sort` normalization are separate:
do not promise equal ranking via `ts_rank` or raw locale collation; admit supported native order or prepare its specified key.

## Smallest access/maintenance alternatives

**Reusable owner-local title derivative.** Attach access metadata to the one directory, with at most one current title-form
bundle per owner/referenced source subject, not per entry, copy, session, alias occurrence, Collection or built-in.
Keep original/terminal source identities distinct; equal strings do not coalesce privacy dependencies. All form bytes/positions
and postings duplicate catalogue title material, not canonical personal facts. Owner-to-subject association is private regardless.
Owner-leading postings can avoid global population discovery, but arbitrary phrase/negative/order conjunctions still prepare.
GIN intersection with a separate owner key does not prove owner-local physical traversal or bounded rejected postings.
A B-tree `(owner,term,subject)` still scans growing postings for common terms and sparse Boolean intersection.
The derivative adds source-to-owner inverse registration, source versions, analyzer versions and bounded repair to every owner.
Its source lifetime is current authorized forms; owner lifetime is retained candidate support, never account history forever.
Last support loss removes it after dependent work is fenced; source withdrawal makes it unusable immediately before physical cleanup.
This is feasible only after full writer/dependency delivery, and is unnecessary for the general initial retained mechanism.

**Retained evaluation without reusable title payload.** Enumerate finite admitted candidates through directory/native scope seeks;
release owner checkout, read bounded complete authorized native title pages, then evaluate locally and commit fenced derived work.
Retain only incomplete evaluation's bounded form/token state when required, source locators/dependencies and query result/order rows.
Discard title bytes/tokens once no retained evaluation needs them. This avoids permanent per-owner public-title duplication.
Do not use one summary fetch per subject: batch full keys per row kind/backend; subdivide source pages by raw rows AND bytes.
Existing full-history readers cannot serve that role unchanged. A single subject with many aliases/history must also make finite progress.
Per-query staged nonmatches/dependencies are permitted preparation, not an all-purpose mirror of private facts or membership.
Curated-only input comes from native occurrences; duplicates collapse in query staging/results, while editor data remains untouched.
Do not persist per-Collection membership in the directory. Its structural supports can identify candidates; actual scope truth stays native.
**Combination:** reuse structural candidate/support metadata and optional measured title access metadata, retaining the same preparation.
Add reusable title terms only if later evidence justifies saved reads versus fanout/storage. No second directory or global catalogue copy.

The closed `owner` operands are `presence:true`, `state:{profileId,stateSetId,in}`, `label:{id}`,
`session:{profileId,lifecycle}` (active/completed/abandoned), and `holding:{profileId,kind?,status?}`.
They compose through shared AND/OR/NOT and saved expansion; no operand accepts a different account ID.
Owner leaves use actual shared meanings: highest LIVE state sequence before matching; effective current label plus live parent;
retained session lifecycle with stored accepting profile; holding qualifiers on the same retained copy; complete presence union.
Everything excludes empty shells, follows, reactions and manual occurrences alone. Label-only and completed-history-only subjects qualify.
Curated members absent Everything remain eligible in that Collection; `NOT state X` includes complete no-entry candidates.
Admitted population bounds complement evaluation. Scope under OR/NOT never expands the source's authorization or chooses another account.
For nonowner public dynamic scope, read completed published membership only, even for an editor; never fresh curator-private facts.

## Physical derivation and retained progress

Let N cover global titles/facts/history, O distinct admitted owner candidates, D extra occurrences/original supports,
q fixed request bytes/terms, s output slots, R composed reads; let L be relevant title bytes, K analyzed term occurrences,
U distinct lexemes and H relevant native owner facts. O is not bounded by 4,096; that number limits an identity group.
History-dependent source readers can touch N-related history even for one key, hence the required indexed current-title producer.

Physical copies: structural directory has O candidate rows plus actual original/family support ranges, not H session witnesses.
Reusable bundle option has one owner/source row per distinct referenced source (at most O+D before shared-source dedup),
L bytes of title payload plus offsets/positions/version keys; postings add U owner/source/term associations and K positions.
One shared title in F owners duplicates its bundle F times; a million sessions for one original do not multiply title bundles.
For illustration only, `(route int4,owner uuid,source uuid)` is 36 payload bytes before versions, varlena, alignment and tuple/index overhead;
two UUIDs per posting cost 32 bytes before term bytes/positions. These are lower-bound components, not measured disk allowances.
PostgreSQL `ts_type.h` represents vectors with 8-byte header, 4 bytes/lexeme, lexeme bytes and 2-byte positions plus counts/alignment;
its position/count/lexeme limits prevent assuming lossless arbitrary title arrays. GIN adds lexeme keys/TIDs, trees and rechecks.
Heap/TOAST, primary/inverse/order indexes, MVCC dead tuples, WAL, pending-list cleanup and replicas add real physical copies/work.
Retained choice has zero reusable title bundles; each live query has up to O unique evaluation/result rows plus actual dependency
registrations and bounded in-flight title state. Worst case across admitted queries is 32× those rows, not one free shared copy.

Initial structural bootstrap costs O(H+D) relevant raw input plus indexed writes, retaining frontiers; it never scans unrelated N.
Title preparation costs O(O+D+L+K) relevant input/evaluation at fixed q, plus ordered index writes O(O log O) in general.
Avoid whole-result terminal sorting; maintain ordered result keys incrementally. Statement count is proportional to bounded steps,
not one request with O statements or O per-subject checkouts. Account for actual B-tree depth and source-history maintenance separately.
Projection update costs changed title bytes/terms plus each affected owner/source bundle and its indexes if that option is used.
Retained-only title changes route to registered live queries, including previously excluded inputs; no update to uninterested owners.
With F interested owners and J affected registrations, total repair is necessarily at least proportional to F/J as applicable;
source transaction records a bounded old/new cause/range, then existing durable jobs page inverse registrations. No synchronous fanout.
Reduction transaction invalidates relevant use immediately; later bounded cleanup/repair cannot supply a privacy lag exemption.

Direct pages must prove c ≤ min(600,6s+3), ≤3 owner seeks, ≤64+16c examined rows and six shared blocks per budgeted row,
≤16+8c points, response 16KiB+4KiB×c and request 64KiB+1KiB×c. One-read allows 12 statements/backend; composed allows 8+4R,
R≤16 and total slots≤128, one connection/backend. `LIMIT s`, a timeout, GIN membership or a small output proves none of these.
Example: one title match after O nonmatches requires Ω(O) evaluation; common-term postings plus a rare owner/Collection condition
can inspect growing rejected rows. Thus no general direct plan is proved. Returned-ID public Search intersection is incomplete.
Ready results examine ≤2s+2 candidates and ≤2 index reads, with the same points/rows/blocks/bytes/statements ceilings.
Excess disclosure rejects return preparation and repair, never a successful short page.

Preparation follows [filtered-list ceilings](../filtered-lists.md#budgets), including 16 statements/backend and all point/byte work;
Kernel's [job authority](../../services/kernel/README.md#bounded-job-steps) further limits native job pages to 100 RAW rows,
100 pages/segment, 5,000-ms command deadline, 8-scalar/2,048-byte frontier and 4,096-byte arguments/results.
This is a job limit, not a universal public 100-raw allowance. Reduce input further when source/dependency/title bytes require it.
Use the shared 32-live-owner-result quota, least-recently-read eviction and 24-hour idle expiry. No extra title quota/budget is proposed.
Existing deadline-bounded contention retries charge every attempt, rollback, discarded read and at most one replayed step's input.
No cross-partition SQL join or held owner connection during source checkout; use Core operational transactions and atomic DBOS intent.

Bootstrap page effects/frontier commit together under the actual writer/CAS boundary; covered-side old/new changes enter retained repair.
Activation serializes with writers and current dependency observations; rereading an old RR snapshot cannot detect a later commit.
Use SCOPED/PARTITIONED/CONCURRENT identity dependencies and complete actual source/query closure, not global active markers,
guessed revision vectors, home sweeps or universal page gates. Disjoint jobs cannot reset an unchanged owner's settled frontier.
For finite unchanged relevant input, fair durable work exhausts candidates/title pages, settles ordered results and produces full/final output.
Repair only affected inputs behind frontiers, retaining completed work. Endless 202/restarts or empty successful raw windows fail.
Opaque cursors bind actual viewer/request text/filter/scope/order and accepted meaning; mutable source/result/analyzer/identity bases
belong in encrypted position using existing codec. Reauthorize every continuation; changed bases restart traversal, never permission.

## Complete invalidation and custody

Register expanded saved AST dependencies across OR/NOT, false/excluded inputs, membership, native fact pins, public selected facts,
title forms/normalization, order and original AND terminal sources, foreign tuple/consent/targets and identity mapping.
Record old/new keys, removals, same-value sequence changes, renamed titles and restored sources, not just positive returned candidates.
Current privacy observation before execution and before disclosure must detect relevant changes even if repaired/ACKed in between.
Native title writers, subject moderation, alias retract/rename, selection/disclosure, source-fence and identity writers must participate.
Parent deletion and title highfanout use bounded dirty ranges plus inverse repair. Candidate Access alone misses excluded/order inputs.
Missing coverage is readiness; a stale false is not complete absence. Private title keys, query definitions and inverse owner IDs stay private.
No private keys enter public logs/indexes; no title cache becomes permission or canonical semantic truth.

Put every derivative, staged token/title payload, dependency, old/new repair, frontier and cursor/result record in Library A5 cleanup.
At account T, fence queued/bootstrap/repair/apply immediately; purge children and all abandoned generations, then heads after hooks stop.
Source withholding disables old payload before reuse; rename/repoint invalidates match AND exclusion/order, including behind-frontier rows.
Exact work/input/output, receipt and event locators belong to Accounts shared-history minimization, with scope/locator-only work payloads.
No title strings/private AST in durable job arguments or diagnostic events. No third identity/erasure participant or false NoData.
Eligible public complete A may survive de-identified; pending B and private title work cannot manufacture output at T.

## Required adversarial traces before any native claim

| Schedule | Required result/evidence |
| --- | --- |
| Sparse title matches late in huge owner history | Bounded retained raw/title steps reach useful full/final pages; no request scan, top-N intersection or repeated zero restart. |
| Manual-only `[x,y,x]`, x absent Everything | Collection scope finds x once in search; occurrence editor retains both x records/notes/order. No persistent per-Collection cache. |
| Label-only; completed session after state clear | Both retain Everything; no fabricated state/profile for label. Completed-session exclusion remains effective after clear; Bob's completion is irrelevant. |
| CJK, Unicode, quoted phrase, negative-only text | Cases above conform to pinned analysis and combined admission; missing title source cannot become a proven negative. Empty header omits text and still applies filters/scope. |
| Same string on withheld original and visible terminal | String equality supplies no support. Only currently eligible original plus terminal can disclose; last eligible alias repair needs indexed access, not group sweep. |
| Rename/withhold/reveal behind prepared frontier | Old positive, false/excluded and order rows invalidate; reveal remains discoverable via retained locators. Repair then revalidate, never candidate-only safety. |
| Source/version/release/edition change | Recheck actual accepted pins, title-source/analyzer and selected catalogue/order dependencies; no reinterpretation through current release or guessed version vector. |
| Owner erase T while title work queued | Apply fails current fence; payload/results/work copies are erased/minimized and cannot recreate directory/head. Completed public A survives only under its existing policy. |
| One title changes across many owners | Source commit has bounded cause; indexed paged fanout catches all affected registrations, including negatives/order, with immediate unsafe-use blocking and finite per-account repair. |
| Crash/replay/bootstrap; cursor reuse | Page/frontier/intent custody is atomic, one-step reread maximum; concurrent first inserts captured; activation uses current cuts. Old cursor reauthorizes/restarts on actual changed bases. |
| Continuous disjoint identity/source jobs | Unchanged owner's finite relevant preparation completes; relevant pending component blocks affected use only. No global marker or universal page gate. |
| `owner label OR Collection C`, `NOT Collection C` with concealed C | Authorize source before evaluation for every referenced scope; concealed identity remains not-found, not false/true or observable metadata. Boolean short-circuit cannot bypass this admission. |

## Smallest producer/SPEC cuts, then implementation

1. Semantic/Search specify TITLE form/analysis/order conformance and negative-only admission using existing parser; agree Collection
   condition wire/population/complement/auth with Commerce. Freeze no guessed helper/signature; preserve catalogue unknown semantics.
2. Semantic supplies indexed complete current label/alias pages with provenance, authorized original/terminal disclosure and retained
   withdrawal/restoration dependencies; integrate all actual source/privacy writers and complete observation/repair ACK. The
   selected-facet contract is required for composed catalogue leaves but does not itself deliver title terms or owner authorization.
3. Commerce supplies the single directory/family indexes and writer-aware bootstrap/selective deltas; complete sequence set/clear/Undo
   cutover, accepted-pin/native session/holding/label access, curated canonical scopes and completed-public dynamic source production.
4. Semantic/Accounts deliver actual scoped concurrent identity STORE/mapping/custody; Library joins the fixed participant and Core
   operational/DBOS producer. Specify retained title evaluator/preparation activation with exact A5/shared-history locators and T fences.
5. Freeze native combined title+real owner AND/OR/NOT+scope scenarios above, current privacy and 64/512/4096 physical cost axes;
   split production cuts within adopted 400-line/eight-path limits. Only then implement and measure, retaining all existing acceptance.

## External primary sources inspected

Reference root is `/home/edge/projects/rezics/rezics-next/.reference/`; existing clones were reused, read only, never installed or run.
- PostgreSQL: `search-canonical-coverage/postgres`, commit `227de22095c8101905ce41e1ebf425239feed079`, PostgreSQL License (`COPYRIGHT`).
  [tsginidx.c](https://github.com/postgres/postgres/blob/227de22095c8101905ce41e1ebf425239feed079/src/backend/utils/adt/tsginidx.c)
  selects full-index mode without required positive matches and requires positional rechecks; `src/backend/tsearch/wparser_def.c`
  uses its own word parser; `src/include/tsearch/ts_type.h` supplies vector layout/limits. These explain why a GIN label proves no page bound.
- OpenSearch: `search-canonical-coverage/opensearch`, commit `4ee42a94e87f66fbf1e62a9871b1b87f91e02472` (3.9.0), Apache-2.0 (`LICENSE.txt`).
  [ICU normalization source](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/plugins/analysis-icu/src/main/java/org/opensearch/index/analysis/IcuNormalizerCharFilterFactory.java),
  sibling `IcuTransformTokenFilterFactory.java`, `server/src/main/java/org/opensearch/index/mapper/TextFieldMapper.java` and
  `gradle/libs.versions.toml` show ICU Normalizer2/transliterator, position-gap handling, Lucene 10.5.1/ICU4J 77.1 dependencies.
- Official [PostgreSQL text controls](https://www.postgresql.org/docs/18/textsearch-controls.html) and
  [text indexes](https://www.postgresql.org/docs/18/textsearch-indexes.html) describe configuration-specific lexemes/positions and GIN postings;
  official [CJK bigram documentation](https://docs.opensearch.org/latest/analyzers/token-filters/cjk-bigram/) describes pair generation.

Shared pattern: parsing, analyzed meaning, indexed access and current disclosure are separate obligations. Reuse the algorithms'
design lessons in native PostgreSQL/TypeScript/Core/DBOS; copy neither source files nor an external library/catalogue architecture.
