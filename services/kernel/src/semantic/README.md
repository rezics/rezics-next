# Semantic

This module owns subject facts and their item projections, partition paging, and immutable definition releases with editorial activation history.

## Authorization

Semantic writes use the route action and authority below. When the authority and target are in different partitions, the route binds a server-owned anchor, validates it, and evaluates Access before checking out the target command partition. Same-partition checks stay on `authorizeCommand`. Community Context anchors are looked up by `(route, context_id)` at command time; the Global Context anchor verifies the seeded global row. Context creation uses the parent creation authorization path.

| Semantic write                     | Action                 | Authority anchor                           |
| ---------------------------------- | ---------------------- | ------------------------------------------ |
| Subject creation                   | `subject:create`       | Global Context                             |
| Subject merge                      | `subject:merge`        | Global Context                             |
| Subject moderation: hide           | `moderation:hide`      | Global Context                             |
| Subject moderation: take down      | `moderation:takedown`  | Global Context                             |
| Subject moderation: restore        | `moderation:takedown`  | Global Context                             |
| Statement disclosure               | `statement:propose`    | Global Context and target account consent  |
| Statement proposal                 | `statement:propose`    | Global Context                             |
| Candidate acceptance and rejection | `context:accept`       | Selected Global or community Context       |
| Candidate adoption                 | `context:adopt`        | Selected Global or community Context       |
| Statement moderation: hide         | `moderation:hide`      | Global Context                             |
| Statement moderation: take down    | `moderation:takedown`  | Global Context                             |
| Statement moderation: restore      | `moderation:takedown`  | Global Context                             |
| Bulk write request                 | `subject:batch_write`  | Global Context                             |
| Each bulk create command           | `subject:create`       | Global Context                             |
| Each bulk proposal command         | `statement:propose`    | Global Context                             |
| Definition publication             | `definitions:publish`  | Global Context                             |
| Definition activation              | `definitions:activate` | Global Context                             |
| Community Context creation         | `context:create`       | Global Context parent, with creation proof |

## Agents

### Account agents

Each account has one graph agent. `accountAgentId(account)` derives a stable v8 subject id from the account id and puts it in the account's route. `ensureAccountAgent(pool, ...)` runs in that partition as platform work, creates a person, organization or software application, and synchronizes the single display-name label. Missing language is stored as `und`. The label is replaced in place without history; `name: null` erases it, including any prior label values. A first ensure with `name: null` creates an unlabeled node. No revision or event payload retains the name. A later ensure with a name restores the label. Changes emit the ordinary subject identity revision event so search drops the old name. Once verification redirects the derived id, ensure returns the linked catalogue subject without editing it, including for `name: null`: the survivor's labels are catalogue facts.

One `semantic.account_agent_subject` row is the back link: it follows the visible subject into that subject's partition and maps the subject to its account. Unique account and derived-agent keys enforce one link per account and one account per catalogue subject. Subject reads expose `account: { id } | null`. A label edit through the ordinary identity writer is refused for an unverified account node. Statement creation and proposal resolve target types and account-agent ownership in the same batched read; only the owning account or platform work can state facts about or pointing to an unverified node. The primary target of a `sourceOrConsent` property is the exception: a reference permits a public assertion pointing at the node, and an unsourced assertion requires that target account. Account-authored statements use the account agent as their source.

`verifyAccountAgent(pool, { account, catalogue, receipt })` is platform work. It requires a visible unlinked catalogue subject of the same kind: a person node must merge into `schema:Person`, an organization node into `schema:Organization`. Software nodes and kind mismatches receive `AccountAgentVerificationError` without changes. Verification keeps the catalogue id as the survivor, records the receipt on the merge revision, moves the back link, and emits the existing merge events. Access derives the subject from its verification record or otherwise from `accountAgentId(account)`; search follows merge events. Each subsequently projected inbound link row, including its Context and filter identity, is recorded in `semantic.account_agent_moved_link` for exact future reversal paging.

`unverifyAccountAgent(pool, { account, receipt })` is platform work for account revocation. It records the revocation receipt on a new merge revision, removes the catalogue back link and account-node redirect, unregisters the node as a member of the catalogue survivor, and restores the account node's own statements and only the inbound links recorded by that verification, in pages. Statements the account made on the catalogue subject while verified stay there with the account as their source. It emits the existing `SUBJECT_REVISED` event at the returned revision with kind `merge`, plus the ordinary change event when needed. Each subsequently projected inbound link row, including its Context and filter identity, is recorded in `semantic.account_agent_moved_link` for exact future reversal paging. A later verification is allowed. Ordinary merges refuse account nodes and linked catalogue subjects.

### Pen names and collective names

A pen name or collective name is a separate person or organization agent with its own page and credits. `rezics:penNameOf` links it to each person or organization behind it; its inverse is “pen names”. Credits never move or copy across that link.

The property's `disclosure: sourceOrConsent` requires either a reference or the target agent's linked account. A sourced statement follows ordinary proposal, acceptance and adoption. An unsourced statement from another account receives `invalid_request` with `/statement/references: required`. The target's account can create or propose an unsourced statement; consent to store it does not publish it. It is accepted in Global but remains private, independently of moderation and Context adoption.

Private candidates share the hidden-statement exclusion probes. Public projections, counts, search snapshots and content disclosure omit them. Subject reads, forward and inverse pages and candidate listings give the linked account and accounts with Global `moderation:hide` access a bounded private overlay. Read permissions and subject moderation still apply. Reader identity is request-scoped and never inherited by relays or exports.

`POST /v1/statements/:id/disclose` uses ordinary proposal admission and checks current target ownership inside the command. It permanently discloses that candidate, bumps the holder's security revision and emits its ordinary link projection. Repeating it is harmless. There is no switch back to private; the target account must retract its statement with `POST /v1/statements/:id/retract`. Retraction is terminal and removes it from current views and projections without making a sourced third-party claim removable by the target. Statements are immutable: adding a reference through editing proposes a sourced replacement in the same target slot, which becomes public through ordinary review. The old private candidate remains private in history.

## Relations

A relation is a statement whose property is an item property and whose value is another subject. Subject-to-subject relations, credits and character appearances all use this one shape; none has a table, endpoint or read path of its own.

### Relation properties

Every item property in a definition release declares how it reads in both directions:

- `inverse`: the property that states the same fact from the value's side, or `symmetric: true` when the fact reads the same from both sides (`same setting`, `alternative version`). A property with neither is shown only on the subject that holds the statement, and the release says so with `inverse: none`.
- `labels` and `inverseLabels`: localized names for each direction ("Sequel" and "Prequel", "Adapted from" and "Adaptations"). A label never has to be inferred by reversing a sentence.
- `group`: the display group a relation belongs to: `order` (prequel, sequel, parent story, side story), `derivation` (adaptation, based on, spin-off, translation, edition), `world` (same setting, alternative setting, alternative version), `membership` (series, part of, collection) or `association` (other Relations view entries); `credit` for staff and cast in Credits and Works, `appearance` for characters in Characters and Appearances, and `classification` for concept-valued facts such as genre, tags, platform, gender and form.
- `targets`: the admitted value types, as for every item property.
- `order`: `position` (the statement's `schema:position`), `date` (the holder's earliest `schema:datePublished`) or `name` (its default label). Missing values sort last; ties use holder id and statement id. Properties without an order retain holder-id order.
- `filter`: one admitted item qualifier whose values select inverse pages, for example a credit role.
- `acyclic: true` when the relation must form a directed acyclic graph (part of, prequel, based on). A write that would close a cycle is refused.

A fact is stored once, on the side the release names as canonical. The other side is a read of the inverse, never a second statement, so the two directions cannot disagree. The inverse is served from inbound-edge rows in the target's partition, maintained from the forward statement and rebuildable from it.

The per-subject cap of 512 applies to descriptive facts, including labels, descriptions, aliases, classifications and every other non-relation statement. A statement is a relation when its property in the release used to write it declares a group of `order`, `derivation`, `world`, `membership`, `association`, `credit` or `appearance`. Relation statements do not count toward that cap. The per-command limit remains 512 facts, so large casts are written across commands.

Relations remain statements and keep the same candidates, slots, Contexts, adoption, revisions, moderation and history as other statements. Each relation slot is keyed by `(subject, property, target)`. A property's optional `relation.slotKey` adds the value of an admitted item qualifier to that identity, for example `wdt:P725` uses `wdt:P453` to give each actor–character pair its own slot. A relation with a resolved target and no slot-key qualifier uses the target slot with an empty key. A `somevalue` with a `schema:sameAs` IRI has its own external-IRI slot; `somevalue` without that qualifier and `novalue` use the property-level slot. A later resolved statement is proposed in its target slot and does not automatically move the unresolved candidate.

Relation slots are projected into `semantic.outbound_link` in the holder's partition, with a mirror in `semantic.inbound_link` in the target's partition. Unresolved relation slots have outbound rows, count toward property totals and have no inbound row. The subject read returns the first 12 selected slots per relation property and its exact count. Both projections carry `context_id`. Global is the base layer; a community Context stores only added or replacing relations and active suppression rows for overridden Global keys. The relay projects Context decisions in both directions. Forward and inverse pages accept `context`, and subject previews use the same ordered merge. Global reads select only Global rows. Global counters retain their existing keys and fixed Global `context_id`; the separate `outbound_link_context_count` and `inbound_link_context_count` tables hold signed deltas keyed by Context. Counts add the Global counter and the selected Context's delta. Subject previews select each projected statement once, even when a slot selects several values. Their resolution diagnostics retain a separate bounded 12-row Global preview for omitted slots.

A source relation is mapped to a release property only after its direction has been checked against the source's documentation and at least one known record. A source relation that no existing standard term expresses gets a `rezics:` term with its own inverse, labels and group; it is never dropped because no Wikidata property matches, and it is never mapped to a looser term that changes its meaning.

An importer turns a source's subject-to-subject relations into these statements on the native subjects; it never keeps them as descriptive records about the source, which no relation read would see.

### Credits and appearances

A credit is a statement on the work whose property names the job and whose value is a person or organization. Its qualifiers record the name as credited, the credit order, the detailed role concept and, for performers, the character portrayed. An appearance is a `schema:character` statement on the work, qualified by its role concept (main, supporting, cameo), the credited name and its spoiler level. Character-to-character relations (family, rivals, alter egos) are ordinary relations between character subjects and follow the rules above.

Spoiler level is a qualifier on the statement, not a property of the character: the same character can be a spoiler in one work and not in another.

Detailed roles are concepts in a role scheme, so every staff position and cast role a source uses has a place; a credit is never dropped or flattened because a closed role list lacks it. Credits are read through the same inverse and forward reads as every other relation, so a credit list and a relation list can never disagree about roles.

The relation properties a subject can take, with their labels and admitted qualifiers, are read from the active release for the subject's type. Every editor builds its choices from that read; none keeps its own list.

### Inverse reads

The value side of a relation is read through an indexed inverse read: the subjects whose statements with a given property point at a given subject, filtered by type and qualifier, ordered by a declared key (credit order, series position, date, name) and paged with an opaque continuation. Every inverse read returns an exact count or an "at least" count. Inverse reads never load the holding subjects' other facts.

`GET /v1/subjects/:id/links` retains the cross-property listing and response shape when `property` is absent. A property page accepts `filter` (one subject id across its declared qualifiers), `type` (a type CURIE, including its subtypes in the active release), `limit` (1–100, default 20), and an opaque `cursor`. Cursors bind the anchor, property, filter, type and the reader's ordered language ranges. Property-page links include the holder's `type` and `label`, chosen by the shared label rule below. Label fills use one batch per holder partition, including the original-language slot, without reading unrelated facts.

Every module embedding a chosen subject label uses `languageRanges` and `chooseLabel` from `language.ts`, including inverse and forward pages, previews and `readSubjectSummaries`. Reads returning all labels retain that shape. The label choice rule is:

1. Parse the whole `Accept-Language` list in descending q order, preserving header order for ties. Ignore malformed entries, q=0 and `*`; put a valid explicit `language` query tag first and keep at most 16 ranges, including that override.
2. For each range in order, match case-insensitively: exact tag, then truncate one subtag at a time (removing a trailing extension singleton too). If none matches, maximize it with `Intl.Locale` and try that likely-script form with the same truncation. Thus `zh-CN` can find `zh-Hans` and `zh-TW` can find `zh-Hant`.
3. After every reader range, try the subject's original language (`schema:inLanguage`) with the same lookup, then English, then the first label in language-tag order. Return null if there are no labels. Preserve the chosen label's actual stored language tag.

The original language is read alongside labels in the same batched statement, with one additional indexed fact range per subject. For multivalued original languages, use the first live preferred statement, then the first live normal statement in slot order. Expanded slots use the current Global adoption. Retracted, deprecated and hidden statements are excluded.

The projection stores a base row with the nil UUID and a row per distinct value across all declared filter qualifiers. A two-role statement appears once in each role page and once unfiltered. Every row carries the holder type and its order key. Name keys use English then the first language tag (without reader or original-language preferences), NFKC case folding and a 256-character cap. Position keys use a fixed-width decimal encoding, preserving large integer ordinals; dates normalize signed years and date parts. The holder computes these keys with its write release. Global adoption of a publication date and identity writes through `updateSubjectIdentity` enqueue paged outbound-link re-emission when holder keys change. Changing a property's declared order or filter list in a release requires a projection rebuild; adding a second qualifier does not backfill existing rows.

Rows and `inbound_link_count` counters change in one partition-fenced transaction, including replay, removal and merge moves. Property and qualifier counts are exact. A type-filtered count samples the first 1,000 rows in the selected property/filter range; it is exact when that range has at most 1,000 rows and otherwise is an "at least" count. This bounded count sample is separate from the page scan. The page scan examines at most `4 × limit + 1` rows under a type filter and can return an empty or short page with a continuation. A continuation advances past examined rows, never past an unexamined match. Freshness waits, authorization and deadline failures follow the existing subject-link read.

`GET /v1/subjects/:id/relations?property=P` reads the holder's forward projection. It accepts the same `filter`, `type`, `limit` (1–100, default 25) and opaque `cursor` parameters. The page is ordered by the property's declared key, includes each selected slot's Context view and the target's type and label, and returns an exact or at-least count. Its type-filtered scan examines at most `4 × limit + 1` rows; the separate type-count sample is capped at 1,000 rows. Unresolved values follow resolved targets and sort by their declared key, then external IRI and statement id. Target labels are filled in one batched read per target partition. Freshness, authorization and deadline handling match `/links`.

Both projections are maintained by the links relay and can be rebuilt from forward statements. Holder type, default label or date changes page through that holder's outbound links and re-emit their inbound rows. A target type, default label or date change pages through its inbound rows and re-emits the holders' outbound rows. Each relay step handles a bounded page; no request performs the full re-emission. Merges page both projections. A merge redirects reads from the source to the survivor without rewriting the source's statements; a later statement on the survivor creates another slot until an editor folds the statements. Revision history already pages revisions, bulk candidate reads probe candidates by slot, moderation reads one slot at a time and pages visibility projection work, and search source reads exclude relation facts from descriptive enumeration.

A hub (a long-running franchise, a prolific voice actor, a genre concept) has an unbounded number of relations, so every view over them is paged and no read enumerates them all. Credits that belong to one episode or one release are stated on that episode or release subject, not on the work.

### Custom relation types

People and communities can add relation types without code. A custom relation type is a property in a definition release and carries everything a bundled relation property carries: localized labels for both directions, inverse or symmetry, acyclicity, group, admitted subject types on both sides, cardinality, admitted qualifiers (ordinal, episode or chapter range, spoiler level, free note), and optional mappings to standard terms (`owl:equivalentProperty`, `skos:exactMatch`, `skos:closeMatch`) used for export. A relation type with no stated meaning, domain and range (a bare "related to") is not admitted.

A custom relation type follows the same lifecycle as any term:

- It is proposed by a person or a Realm and becomes usable when its definition release is reviewed and activated; the editor that proposes it is a form over the release format, not a separate store.
- It has one meaning for its lifetime. A changed meaning is a new term; the old one is deprecated with a pointer.
- Statements that use it are proposed, accepted and adopted in a Context like any other statement, keep their evidence and history, and can be moderated.
- It is visible where its Context is selected. A Realm's relation type shows on that Realm's pages and on the global page only after Global adopts the term and the statements.
- It is queryable in search filters and inverse reads exactly like a bundled property.
- A graph view over it is a bounded neighbourhood read: an anchor, a depth of at most two, an explicit set of properties and a page size. Unanchored closure (all ancestors, all connected works) is not a read.
- A layout or grouping a person arranges for a graph view is view state; it never changes the facts.

The number of custom relation types is limited per Context; statements that use one are stored, paged and counted exactly like statements that use a bundled relation property.

## Cost

These bounds follow `subject.ts`, `links.ts`, `page.ts`, `item.ts`, `definitions.ts`, `bulk.ts`, `fences.ts`, their SQL, `http/subjects.ts`, `http/bulk.ts`, `semantic/http/definitions.ts`, and the subject/definition migrations and schema dumps; they are derivations, not measurements.
Let N be total subjects, P subjects in the anchor partition, F stored fact rows of one subject, at most 512, d page depth, s page size, i batch ids, at most 256, D definition revisions (bounding both releases and activations), and M activated vertical manifests together with the bundled catalogue. U×t is one subject's editorial history.
For several subjects, F denotes their maximum; logarithms mean `log(2 + size)`.
Rows means rows examined, including filtered rows, not just returned rows; blocks means shared blocks accessed, including index, heap, and payload blocks, rather than cache misses or elapsed time.
A B-tree point probe examines O(1) rows and O(log size) blocks; range retrieval adds its visited rows and blocks, and inserts add logarithmic index work per row.
The table gives the supported indexed access shape, not a promise that PostgreSQL always chooses it; a possible partition scan is identified explicitly.
Fact indexes have size up to N times F, so write `L = log(N(1 + F))`; with bounded F this is O(log N).
Command history can grow without new subjects: let H count receipts/outbox/write-basis rows and `C = log(2 + H)`; it cannot honestly be bounded by N alone.
For variable-size subject payloads add B shared blocks, where B is the total payload blocks read or written (including the receipt); growth checks hold B fixed. Structural validation caps decimal strings at 127 characters and time years at 16 digits, so every value has a fixed maximum size. Bounds assume fixed payload sizes; definition validation enforces a 4 MiB release limit before publishing, with 1,024 types, 4,096 properties and 64 properties per type, and validates cold reads too. A cold read is linear in the release's canonical bytes and happens once per digest per process. A warm cache, keyed by digest, serves later requests from the validated body. Those requests touch the subject's type and the properties on its facts; they do not iterate the release. Their rows, blocks and statements are constant in M.
Each write command refuses more than 512 submitted facts before SQL. The subject's `current_facts` cap counts descriptive facts only. Each slot's `log_seq` stops at 33, and only an expand row may use 33.
`pageSubjects` enforces 1 <= s <= 100 at read entry (default 25) and fetches s + 1 subjects by primary key. A batched read refuses more than 256 ids before SQL.
For batches, g is the number of nonempty partitions, at most min(i, 4096), and P is the largest touched partition; for authorization, G is resource permission rows, U membership-history rows examined, q candidate organizations, and A total Access rows.
A sourced batch has at most 100 commands. T is the number of distinct source tuples among the candidates a read would show, bounded by the statements on that page. Source-fence reads use content's `readFences`: one statement per tuple partition, at most 100 tuples, so a larger page takes `ceil(T / 100)` statements in that partition.
`subject_pkey(route, subject_id)` and `fact_pkey(route, subject_id, slot_id, log_seq)` locate a subject and one slot. `fact_label (route, subject_id, language) WHERE kind = 'label' AND operation = 'assert'` reaches label rows without the subject's other facts.
Counts below exclude the separately listed authorization cost unless a subsection includes it. A page read uses BEGIN, SET timeout, partition SELECT, one page SELECT, COMMIT (five statements); link and relation pages add one `SET LOCAL enable_seqscan = off` before their indexed projection range. Inverse link pages also probe pending merge work for at most `4 × limit + 1` scanned holder ids, then reread the page after that work finishes. A subject read checks the current partition's projection checkpoint before its snapshot, then adds one `SET LOCAL enable_seqscan = off` when its type has relation properties, one statement per descriptive slot view, one 13-row outbound range and one counter probe per relation property, 12 relation slot views per property, and one batched read per related partition. The checkpoint wait includes a pending merge-member probe.
For commands, K denotes seven framework statements per successful fresh attempt: BEGIN, two SETs, time SELECT, another SET, fence SQL, COMMIT; add one receipt SELECT when configured and the body statements below.
The fence statement updates one `core.partition` row through `partition_pkey`, inserts one `core.outbox` row per event through `outbox_pkey`, and optionally one `core.receipt` and one `editorial.write_basis` row through `receipt_pkey`, `write_basis_pkey` and `write_basis_partition_no_position_key`; their partition foreign keys probe `partition_pkey`.
Contention retries stop at three attempts; fence waits and retries use the deadline (default two seconds), so the stated counts are per attempt, with extra constant-size partition polls, rather than a claim about machine speed.

### Command and receipt

- Touches: `runCommand` reads time without a relation and 0/1 receipt by its full PK; fresh fence writes partition 1, outbox 1 (2 for bootstrap), basis 0/1, receipt 0/1 as above. Replay authorizes before receipt, returns its saved response, and skips body/fence. Grow total N and H; fix F, event count and authorization evidence.
- Bound: Fresh rows O(1), blocks O(C), statements K + 1 + body for receipted commands; replay rows O(1), blocks O(C), six framework statements, no writes.
- Growth check: `test/semantic/growth-subjects.test.ts`: `Command and receipt stays within its bound as N grows`, scales `[1, 4, 16]`.

### Subject creation

- Touches: `createSubject`: insert 1 `semantic.subject` via `subject_pkey`; one `insert-facts.sql` inserts F `semantic.fact` rows via `fact_pkey` and F subject FK probes; receipt stores the resolved item, fence emits 1 event. Grow total N; fix F, partition and command history size.
- Bound: Rows O(1 + F), blocks O((1 + F)L + C), two body statements, ten including receipted command; F <= 512 in `writeFacts` before any insert.
- Growth check: `test/semantic/growth-subjects.test.ts`: `Subject creation stays within its bound as N grows`, scales `[1, 4, 16]`.

### Account agents

- Touches: `ensureAccountAgent` reads the node by its derived id and writes at most the subject, its label and the back link. Label synchronization deletes the node's label rows and installs zero or one replacement, without reading or changing other facts. It records a name-free identity revision and subject event. Migration removes prior label history once. Verification is one merge. Inbound link moves append one reversal row per moved link row. The write-rule probe adds the back-link lookup to the batched target-type read. Grow total subjects and links; fix the account, label count, merge page and authorization evidence.
- Bound: Ensure and label erasure touch O(1) rows and statements, independent of previous name changes. Erasure touches only that node's label rows, plus constant revision, subject and command bookkeeping. The write-rule probe adds no statement per target. Verification uses the existing merge page cost plus O(L) ledger rows for L moved statements.
- Growth check: `test/semantic/account-agent-cost.test.ts`: `account agent ensure uses constant statements as account agents grow` at scales `[1, 8, 64]`; `test/semantic/account-agent-cost.test.ts`: `account agent ownership probe uses constant statements at targets 1, 8 and 64` at scales `[1, 8, 64]`.

### Private statements

- Touches: one disclosure row per protected candidate, the existing hidden-candidate batch probes, and indexed audience ranges for private page overlays. A private inverse range spans holder partitions, indexed by target and account; its SQL declares that exception. Public background reads always exclude private candidates.
- Bound: no per-statement read is added. Anonymous pages add no statements or rows; authenticated public pages have a fixed audience-range query returning one aggregate row and no private entries. Disclosure updates one statement and performs its ordinary projection, including registered Context layers, O(1) plus that projection. Existing Context suppressions and replacements retain their pages and counts after disclosure or retraction.
- Growth check: `test/semantic/growth-private-statements.test.ts`: `public inverse rows stay flat with 64, 512 and 4096 private pen-name links`, scales `[64, 512, 4096]`, one warm-up per scale.

### Verification reversal

- Touches: the back link, account-node redirect, survivor membership, and the per-filter inbound link rows recorded as moved from the account node.
- Bound: Rows O(links moved from the node), independent of the survivor's in-degree; reversal processes the recorded links in pages and never scans the survivor's links.
- Growth check: `test/semantic/agent-verification-reversal.test.ts`: `verification reversal growth stays flat across survivor in-degree` with scales `[64, 512, 4096]`.

### Anchored subject read

- Touches: `read-subject.sql` probes one subject, its latest redirect and its latest revision, and reads its non-statement facts. Each property reads that slot's compact rows or, once expanded, its current adoption and its selected candidates by key, plus at most 32 current rejections through `acceptance_current_rejected`. It does not read the slot's other candidates or `semantic.acceptance` history. HTTP then fills related labels, eligibility, visibility and redirects with one batched read per related partition. Grow the subject's history through proposals, verdicts and adoptions in Global and in a Context, and one hidden statement; the subject stays fixed. A route key adds one source-fence read for the statements shown. The self summary and related summaries use the shared batched label statement, including the original-language slot, with the costs derived under Subject summaries.
- Bound: Rows O(F + 12 × p), where F is at most 512 descriptive facts and p is the number of relation properties on the type (at most 64); each property range reads one extra sentinel row to continue the preview. Blocks are O((F + 13p + related) log N). Semantic statements are O(p + related partitions). Independent of the number of relations held and of U×t. The display fills add O((i + 1) × (labels + 65)) rows for i ≤ 256 related ids and O(subject, edition and media partitions) statements. Access still runs one permission check per related id.
- Growth check: `test/semantic/growth-relations.test.ts`: `A subject read examines the same rows whatever the number of relations it holds`, scales `[64, 512, 4096]`; `test/semantic/growth-reads.test.ts`: `Anchored subject read stays within its bound as the subject's history grows`, scales `[8, 64, 512]`.

### Forward relation page

- Touches: one outbound index range (`limit + 1`, or at most `4 × limit + 1` under a type filter), one counter probe, the selected slot views, and one target-label read per page partition. Each target adds one `fact_pkey` range for the original-language slot (at most 33 fact rows); an expanded slot adds its current Global adoption and at most 32 selected candidates and hidden-candidate probes, all in that same statement. The type-filtered count has its own sample of at most 1,000 projection rows.
- Bound: Rows O(s) (O(s + 1,000) with a type count), blocks O(s log N + partitions), statements O(1 + page partitions), independent of the holder's relation count. Slot views and label fills are bounded by the page: for i ≤ s targets, label work is O(i × (labels + 33 + 32)) rows and O(i × (labels + 65) log N) blocks, with no extra statements per target.
- Growth check: `test/semantic/growth-relations.test.ts`: `A subject read examines the same rows whatever the number of relations it holds`, scales `[64, 512, 4096]`, also measures a middle forward page filtered by the second of two qualifiers at limit 25.

### Material-list statements

The catalogue's `wdt:P186` uses the forward relation path above, ordered by
`schema:position`, with one slot per target. Adding this property to a type adds
one 13-row range, one counter probe and at most 12 slot views to its subject
preview, plus bounded target fills. Full material lists use paged relation reads;
each request is bounded by its page limit. Creation checks the 32-selection limit
per target slot (including a declared slot key), while preserving the 512-fact
command budget. Exact quantity and bound checks run before SQL and add no
statements. Document instructions reuse the existing imported or authored field
append, with no additional SQL. The API round trips are covered by
`test/semantic/recipe-structure.test.ts`.

### Key-change re-emission page

- Touches: one indexed source projection range of at most 101 present rows, at most 100 changed mirror rows with fixed qualifier/filter fanout and fixed partitions, fixed identity/key point reads, and one continuation command. The five-part keyset cursor advances through the exact last examined row, including all filter rows, NIL targets and Contexts.
- Bound: rows and statements per step are independent of total degree and relation history; blocks are logarithmic in involved indexes. Mirror lookups probe the full stable identity, and inactive outbound rows use the exact tuple found by that probe. Total eventual catch-up is O(degree) over separate bounded steps, never one request or one relay snapshot.
- Growth check: `test/semantic/growth-key-reemit.test.ts`, `holder key re-emission processes a bounded page as its out-degree grows` and `target key re-emission processes a bounded page as its in-degree grows`, `[64,512,4096]`.

### Batch label fill

- Touches: `readLabels` takes at most 256 ids, groups them by partition, and issues one statement per partition. Each id is an exact `(route, subject_id)` pair: one `subject_pkey` probe and one `fact_label` probe. The label probe reads label rows only. Grow that partition and the total; the eight subjects stay fixed.
- Bound: Rows O(i × labels), blocks O(i log N), one statement per nonempty partition. Independent of P. i is at most 256.
- Growth check: `test/semantic/growth-reads.test.ts`: `Batch label fill stays within its bound as its partition grows`, scales `[1, 8, 64]`.

### Partition keyset page

- Touches: `page-subjects.sql` reads s + 1 subjects by `subject_pkey` with a bound limit, then each of those rows probes `fact_label` for its label rows only. The label probe is a per-row read. `readPartition` reads one `core.partition` row. Grow the partition, the total and page depth; the check uses page size 1.
- Bound: Rows O((s + 1) × labels), blocks O((s + 1) log N), five statements. Independent of P, of d, and of facts other than labels.
- Growth check: `test/semantic/growth-subjects.test.ts`: `Partition keyset page stays within its bound as d grows`, scales `[1, 4, 16]`.

### Item projection and related labels

- Touches: `resolveItem` uses the facts already returned and reads no relation. Related subject labels, eligibility, visibility and redirects are one batched read per related partition, at most 256 ids, not one read per id. Property labels come from the cached release. HTTP also fills the shared summaries for the related ids (including original-language label choice for representative covers), at the cost derived under Subject summaries. Grow the related partitions and the total; the subject and its six related ids stay fixed.
- Bound: Projection reads no rows. Related fill rows O(i × labels), blocks O(i log N), semantic statements O(related partitions). Independent of P. The additional summary fill costs O(i × (labels + 65)) rows and O(subject, edition and media partitions) statements. Access permission checks remain one per related id and are bounded by that same fixed id list.
- Growth check: `test/semantic/growth-reads.test.ts`: `Related labels of a subject read stay within their bound as the related partitions grow`, scales `[1, 8, 64]`.

### Definition publish

- Touches: `publishRelease`: validate/hash one body, insert 0/1 `semantic.definition_release` through `definition_release_pkey(route, digest)`, conflict does nothing; receipted command emits 1 event even on existing digest. Grow D and H; fix body size and authorization evidence.
- Bound: Rows O(1), blocks O(log D + C), one body statement, nine including command; no scan of prior releases.
- Growth check: `test/semantic/growth-definitions.test.ts`: `Definition publish stays within its bound as D grows`, scales `[1, 4, 16]`.

### Definition activate

- Touches: `activateRelease`: read 0/1 release body via `definition_release_pkey`; activation SQL reads latest head through backward `definition_activation_pkey(route, head)` then inserts 0/1 activation with expected-head conflict protection and release FK probe. Grow D; fix body size, H and authorization evidence.
- Bound: Rows O(1), blocks O(log D + C), two body statements, ten including command; stale head writes no activation and rolls back.
- Growth check: `test/semantic/growth-definitions.test.ts`: `Definition activate stays within its bound as D grows`, scales `[1, 4, 16]`.

### Definition read

- Touches: `readRelease`: a malformed digest does no SQL. A cache hit reads 0/1 digest through `definition_release_pkey` and returns the cached body; a miss reads the body, validates it, checks the digest and freezes it. The cache holds only validated, digest-checked bodies, and a release is immutable, so a hit does not read the body. HTTP authorizes the global context first. Grow D; exercise a warm and a cold cache.
- Bound: Rows O(1), blocks O(log D) on a hit. A cold read is linear in release bytes, once per digest per process. Zero or one data statement; no history scan.
- Growth check: `test/semantic/growth-definitions.test.ts`: `Definition read stays within its bound as D grows`, scales `[1, 4, 16]`.

### Active definition lookup

- Touches: `activeRelease` / HTTP active endpoint: backward activation PK probe for route 0 with LIMIT 1 reads 0/1 head; cache miss adds Definition read. Subject commands call `activeRelease` for this pointer; a cache hit adds no body read. Grow D; fix active body size and authorization evidence, exercise a cold cache. The manifest rows below bound request cost in M.
- Bound: Rows O(1), blocks O(log D), one data statement on a cache hit and two on a miss. A subject request pays this pointer; a cache hit adds no definition-body statement.
- Growth check: `test/semantic/growth-definitions.test.ts`: `Active definition lookup stays within its bound as D grows`, scales `[1, 4, 16]`.

### Definition bootstrap

- Touches: `bootstrapRelease`: outer latest-head probe; when absent, command repeats probe, publishes 0/1 release, inserts first activation and emits 2 events, no receipt/basis. Uses definition PKs and fence indexes above. Grow D and H; fix body size, including already-active fast path.
- Bound: Rows O(1), blocks O(log D + C), one statement if active, otherwise eleven including command; race recovery may add one head lookup after rollback.
- Growth check: `test/semantic/growth-definitions.test.ts`: `Definition bootstrap stays within its bound as D grows`, scales `[1, 4, 16]`.

### Typed validation

- Touches: `checkTyped` in `rules.ts` checks a supplied release and input in memory, uses the portable checks, which cache compiled validators per release/property and returns referenced item targets without fetching them; it is not wired into subject HTTP on this base. Grow D; fix supplied release, input values and cache state.
- Bound: Zero relation rows, shared blocks or SQL statements; work follows supplied statement/qualifier/reference values, with no internal input-count cap and no iteration over D releases.
- Growth check: `test/semantic/growth-definitions.test.ts`: `Typed validation stays within its bound as D grows`, scales `[1, 4, 16]`.

### Request authorization

- Touches: Subject/definition HTTP checks call Access preparation then final resource check; no semantic relations. Default Access reads account/optional assignment by `account_pkey`/`principal_assignment_pkey`, resource grant/role-grant/denial prefixes through their temporal GiST PKs, and organization memberships through `organization_member_pkey` plus organization account PK; candidate organizations cause up to two membership statements each. Grow total N or D; hold this Access neighbourhood fixed.
- Bound: Rows O(1 + G + U + q), statements O(1 + q); temporal GiST access has a conservative O((1 + q)A) block bound, not the B-tree point-probe guarantee. Independent of N, P, d, D with Access data fixed; uncapped G, U and q exceed the criterion through evidence fan-out and permission history scans.
- Growth check: `test/semantic/growth-subjects.test.ts`: `Request authorization stays within its bound as N grows`, scales `[1, 4, 16]`.

### Subject creation across manifests

- Touches: HTTP `createSubject` on the active release. A warm cache resolves the activation pointer and looks up datatypes for the new facts only. Grow M; fix the subject's type, fact count and authorization evidence.
- Bound: Rows, blocks and statements constant in M. In-process work touches that type and those properties through the digest cache.
- Growth check: `test/semantic/expansion.test.ts`: `subject commands and reads stay within budget at 10 and at 100 vertical manifests`, scales `[1, 10, 100]`.

### Statement proposal across manifests

- Touches: HTTP `proposeStatement` on the active release. A warm cache resolves the activation pointer and checks the one property on the subject's type. Grow M; fix the statement and authorization evidence.
- Bound: Rows, blocks and statements constant in M. No iteration of the release.
- Growth check: `test/semantic/expansion.test.ts`: `subject commands and reads stay within budget at 10 and at 100 vertical manifests`, scales `[1, 10, 100]`.

### Candidate acceptance across manifests

- Touches: HTTP `decideCandidate`. Acceptance does not load a release body. Grow M; fix the candidate and authorization evidence.
- Bound: Rows, blocks and statements constant in M.
- Growth check: `test/semantic/expansion.test.ts`: `subject commands and reads stay within budget at 10 and at 100 vertical manifests`, scales `[1, 10, 100]`.

### Candidate adoption across manifests

- Touches: HTTP `adoptCandidates` on the active release. A warm cache resolves the activation pointer and checks that one property on the subject's type. Grow M; fix the selection and authorization evidence.
- Bound: Rows, blocks and statements constant in M. No iteration of the release.
- Growth check: `test/semantic/expansion.test.ts`: `subject commands and reads stay within budget at 10 and at 100 vertical manifests`, scales `[1, 10, 100]`.

### Anchored read with related labels across manifests

- Touches: HTTP subject read. `readSubject` loads descriptive facts and the first 12 relation slots for each relation property on the type, then `readRelease` for related property labels and one batched related read per partition for the preview's targets. A warm `readRelease` reads the digest only. Grow M; fix the type, F, preview size and authorization evidence.
- Bound: Rows, blocks and statements constant in M. In-process work uses the type's relation properties, descriptive facts and bounded preview. A cold release read is linear in release bytes, once per digest per process.
- Growth check: `test/semantic/expansion.test.ts`: `subject commands and reads stay within budget at 10 and at 100 vertical manifests`, scales `[1, 10, 100]`.

### Candidate listing across manifests

- Touches: HTTP `listCandidates`. One `readRelease` per distinct candidate release, then datatypes for that candidate's fact only, plus one `slotView`. A warm `readRelease` reads the digest only. Grow M; fix the property, page size and authorization evidence.
- Bound: Rows, blocks and statements constant in M. No iteration of the release. A cold release read is linear in release bytes, once per digest per process. A route key adds one `readFences` per tuple partition among the candidates shown, T probes chunked at 100, independent of N and of the subject's history.
- Growth check: `test/semantic/expansion.test.ts`: `subject commands and reads stay within budget at 10 and at 100 vertical manifests`, scales `[1, 10, 100]`.

### Authored documents

Single-subject creation and statement proposals accept document values as
`{ document, licence, language }`: a Text or Blocks snapshot, an SPDX licence or
`LicenseRef-` identifier, and a BCP 47 language tag. Validation happens before the
command. Media values remain `unsupported`, including qualifiers and references.
The bulk `summary` field group accepts every `document` property with source
evidence and rights, including how-to instructions. Text and Blocks snapshots
share the existing content append path. Document validation and exact quantity
bounds add no SQL statements.

The containing statement allocates the candidate and revision before content's
`appendAuthoredField` runs in the same transaction. Creation uses its compact
statement ID at revision 1. Semantic stores only `{ language, document: id, digest }`;
content keeps the body, licence and command's acting account. Each append emits
`com.rezics.content.authored-field.created.v1`. Qualifier and reference documents
share their containing candidate. Disclosure follows that candidate's visibility.
Install hooks return replacement values and facts are written from copies, so a
serialization retry cannot replace a request snapshot with a stored document ID.
A failed append or later write rolls back the entire command.

The append adds one exact insert per document with at most 2 MiB of canonical
bytes; there is no history scan or cleanup command. The API and retry checks are
in `test/semantic/authored-documents.test.ts`.

### Sourced bulk write

- Proposal install hooks return replacement values and never mutate command input.
- Touches: One `readFences` statement per source-tuple partition (at most 100 tuples) before the receipt and before deduplication; one anchored media reference probe per cover; each command then pays its single-request cost plus one document insert or one media claim by key. Same-partition fence reads run inside the command. Grow N; fix the command count at the batch cap.
- Bound: O(commands × log N). At most 100 commands. No path scans a partition or table, or grows with N, U×t or M beyond index depth.
- Growth check: `test/semantic/growth-sourced-writes.test.ts`: `a sourced bulk write at a fixed batch has constant rows and statements as subjects, documents and fences grow`, scales `[1, 4, 16]`; fixed-fixture checks in `test/semantic/imported-fields.test.ts`: `a cover proposal claims an available cover media object in its own transaction` and `an unchanged summary refresh appends no document`.

### Source-fence disclosure

- Touches: Subject views, candidate listings, and the search source read each issue one `readFences` statement per tuple partition among the candidates that read would show. The search source read adds the same per read.
- Bound: T probes, `ceil(T / 100)` statements in a partition, independent of N and of the subject's history.
- Growth check: `test/semantic/growth-sourced-writes.test.ts`: `source-fence disclosure on a subject view has constant rows and statements as subjects, fences and the subject's history grow`, scales `[1, 4, 16]`; fixed-fixture check in `test/semantic/imported-fields.test.ts`: `a fenced source tuple refuses new contributions and hides existing ones at read`.

Structural value limits bound subject payload blocks B by F for accepted inputs; shared-block growth checks keep payload size fixed.
Default authorization has separately anchored but uncapped evidence fan-out; its costs cannot be proved bounded using subject and definition counts alone.
All writes serialize on their own `core.partition.position` counter, with definitions sharing partition 0; this is a partition-local lock/counter, not a global counter across all subject partitions.
Fact/subject and activation/release joins and foreign keys stay on the same route, while related-label and Access evidence reads cross partitions as separate reads without a cross-partition join or transaction; the in-process release cache affects constants, not the cold lookup bound.
The global context is inserted once by migration and has no runtime semantic read/write path.

### Context relation page

- Touches: two ordered index ranges (Context rows and Global rows) in one partition, merged; two counter probes. The indexes cover suppression flags; forward pages fetch payloads by key only after the page limit. Active suppression rows override Global keys; relay tombstones do not override them. Merge and key-change continuations include Context in their keys.
- Bound: rows O(s + suppressions in the page's range); independent of Global's and the Context's totals elsewhere.
- Growth check: `test/semantic/context-relations.test.ts`: `a Context relation page examines rows bounded by the page and the Context's own changes in its range`, scales `[16, 128, 1024]` Context changes outside the page's property range; forward and inverse page rows stay flat.

### Inverse page

- Touches: one index range on the anchor's partition (`s + 1` rows, or at most `4s + 1` under a type filter), one pending-merge index probe for the scanned holder ids, one counter probe, and the shared subject-summary reads for holders on the page. Type counts add a separate sample of at most 1,000 index rows.
- Bound: rows O(s) (O(s + 1,000) with type counts), blocks O(s + log N), statements O(1 + partitions on the page) ≤ O(s), independent of in-degree. For i ≤ s returned holders, the label and original-language fill adds O(i × (labels + 65)) rows and O(i × (labels + 65) log N) blocks in the same per-partition summary statements; selected-cover costs are derived below.
- Growth check: `test/semantic/growth-inverse-pages.test.ts`: `an inverse page examines the same rows whatever the anchor's in-degree`, scales `[64, 512, 4096]` at limit 25; first and middle pages filtered by the second of two qualifiers have flat rows and blocks.

### Graph read

- Touches: for each depth, one index range of at most `limit + 1` rows per `(node, property, direction)`, batched into one statement per partition, plus one count probe per expansion. Node labels use the existing batched label read and types use one batched read per partition.
- Bound: rows O(min(500, (p × l)²)); statements O(partitions touched) ≤ O(p × l) per depth. Cost is independent of graph size beyond the response and page bounds.
- Growth check: `test/semantic/graph-read.test.ts`: `a graph read costs the same whatever the size of the graph beyond its bounds`, scales `[64, 512, 4096]` at depth 2 and limit 12; rows and statements stay flat.

### Links projection write

- Touches: per changed statement, `1 + distinct values across both filter qualifiers` rows and their counters in the target partition. The stable row identity includes the filter value; the partial present-row index orders `(route, subject_id, context_id, property, filter_value, order_key, source_subject_id, statement_id)`.
- Bound: O(changed statements × (1 + values of both qualifiers)) per event. Key changes enqueue paged re-emission, with O(page) work per relay step and O(degree) work spread across steps. Tombstones retain source revision and security revision so replay cannot resurrect removed rows or double-count them. Merge pages carry all keys and resume through the filter value and Context. A Global change also probes the override index for its changed keys and adjusts those Context deltas; Global adoption reconciles the Contexts registered for that slot, so its work also includes the affected Context rows.
- Growth check: `test/semantic/growth-inverse-pages.test.ts`: `links projection work grows with changed links and stays flat in in-degree`, three projection rows per changed statement (base, role and arc), a measured loop over 10, 100 and 500 changed links and an in-degree check at scales `[64, 512, 4096]`.

### Subject summaries

- Touches: per subject partition, one indexed 12-row representative-edition range and one batched read of the subjects, their default labels, and their preferred images or selected representative-edition slots. The same statement adds one `fact_pkey` range for each subject's `schema:inLanguage` slot (at most 33 rows), and, if expanded, one current Global adoption plus at most 32 selected candidates and hidden-candidate probes. Per edition partition, one batched read of the editions' preferred images. Per media partition, one content cover reference read.
- Bound: rows O(i × (labels + 33 + 32)) for i ≤ 256 ids, with the existing image and 12 representative slot probes bounded independently; statements O(subject partitions + edition partitions + media partitions) ≤ O(3i); independent of how many editions a work has. Blocks are O(i × (labels + 65) log N) plus the existing bounded cover lookups. Access preparation and authorization retain their separately documented evidence costs.
- Growth check: `test/semantic/subject-summaries.test.ts`: `subject summaries for a page use two bounded reads per partition, not one read per subject`, scales `[4, 32, 256]` ids; `test/semantic/subject-summaries.test.ts`: `a representative cover read stays flat as the work gains editions`, scales `[16, 128, 1024]` editions. Statements and rows per id stay flat.

`readSubjectSummaries` is the shared display projection. Callers provide the active release and a current reader authorization check; representative editions pass that same check. Its `languages` option receives the parsed ranges and its labels follow the shared label rule above. The selected label's actual language selects a representative edition among the first 12 rows in the outbound projection, falling back to an unqualified representative and then the first row. The projection range runs with sequential scans disabled; the batched summary query uses the normal planner. Preferred images win over normal images; deprecated, hidden and retracted statements are omitted, including expanded slots' current Global adoption. An unavailable chosen image yields null rather than switching editions. Suitability policies may withhold a cover through `maySeeCover`, producing null without hiding the subject.

Global and community Context subject reads return `summary` beside `subject`. Their related subject fills retain `labels` and any redirect and add `type`, `types` and `cover`. Property definitions retain their label-only shape. Cover summaries contain media ids and authored display metadata; variant URLs are built by clients through the media route.
