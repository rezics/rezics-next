# Raw-update caller migration classes

Analysis date: 2026-10-11. This is Step A of [G-1636](../tasks/G-1636.md),
not an implementation or acceptance run. The current derived inventory has
**149 integration roots**, not the former brief's 30 files. Every root is
assigned once in the inventory below; imported helpers are evidence, not
additional roots. A mixed file belongs to its hardest write requirement.

The migration cannot honestly be specified as 149 immediately executable
replacements. Some tests manufacture corrupt receipts, missing retained
objects, legacy representations or arbitrary model heads which current
product commands deliberately cannot create. Their sole permitted candidate
is restoration of an authentic retained store, but no such compatible backup
is established here. They are explicitly blocked, rather than described as a
supported fixture mechanism. A backup made by secretly applying their old
SPARQL would violate this brief.

## Evidence and limits

- [The scan](../../../../scripts/qa/isolated-integration-files.ts) recursively
  follows imports from integration roots. [Its tests](../../../../scripts/qa/raw-update-scan.test.ts)
  cover direct updates, HTTP `/update` helpers, transitive support and
  unresolved imports. Read-only invocation of `rawSparqlIntegrationScan()`
  returned 149 roots. The shrinking ceiling in
  [raw-sparql-integration-files.test.ts](../../../../scripts/qa/raw-sparql-integration-files.test.ts)
  is a regression guard, not the authoritative inventory. Do not hand-edit a
  derived set to remove a caller; remove its last reachable raw write.
- [Shard planning](../../../../scripts/qa/integration-shards.ts) splits reusable
  product and raw callers before packing. An isolated file gets its own reset
  batch; command-only and resource-class files get their own project. Raw and
  product callers never share an assembler. [Stack selection](../../../../scripts/qa/stack-environment.ts)
  grants Work-scope admission only when both the selected roots and stack
  mode are free of raw update. `scripts/qa/cli.ts` selects
  `/fuseki/fuseki-text.ttl` for those product integration stacks; persistent
  non-command-only projects can instead select the explicit QA raw mode.
  Migration of a root does not alone change persistent stack-mode policy.
- Raw maintenance invalidates membership, source/catalogue basis and Work-name
  proofs in `TemplateIndexService.java:891–899`. Restoring those proofs after
  every fixture mutation would be a second fixture mechanism. Use the owning
  command and existing restore migrations instead.
- [G-1637](G-1637-specification.md) establishes the G-829 membership-proof
  invalidation and native refusal. [G-1639](G-1639-specification.md) distinguishes
  stale Statement pins, model races and real recovery-command failures.
  In particular, fault-recovery `source-field-child.test.ts` uses the
  authenticated command endpoint; it is not a raw-integration caller and
  is outside this inventory. This plan cannot claim its LIVE04 repair.
- `.temp/goal-program/run9-failure-clusters.json` is absent in this worktree;
  so are local run-9 QA XML/log artifacts. Main-checkout paths were not used
  as a substitute. The requested `Fuseki update returned N: ...` clusters
  therefore cannot be independently inspected or mapped to durations here.
  The earlier committed reports are secondary evidence with their stated
  qualification limits, not a replacement for that JSON.

**Before seconds per file:** `scripts/qa/core.ts:754–847` reads the maximum
of the last three successful observations and otherwise uses the median of
known durations, or **30 seconds** when none are known. The scan contains
no durations. With no local timing history, the inventory uses `E30`, meaning
that exact existing **planner estimate**, not a measured run time, for every
root except G-829. G-1637 records **28.6 seconds of process time** for G-829
in exact-order run `20261011t072913-f689be`; that overall invocation failed
source-stability qualification. It is a diagnostic observation, not a green
baseline or a JUnit duration. Do not advertise performance improvements from
these estimates. Before/after measurements remain a migration-session check.

## Class table

The per-file inventory is the authoritative membership and write-shape column
for this table. All session counts below are planning estimates for Luna/max,
including fixture migration and targeted proof, not measured productivity.

| Class | Files | What they write | One store-shaping mechanism and why | Luna/max sessions; claims | Order/dependencies |
| --- | --- | --- | --- | --- | --- |
| A — identities, publication and protection | Inventory rows marked A | Agents/organizations, Spaces, real publication selections, Work type/protection; replacement of destructive global Context isolation | **Product command/API.** Small fixtures must retain admission, authority and original revision witnesses. Reimporting or restoring arbitrary triples does not prove those transitions. | 5–8 batches of 2–4 roots; root-only claims where possible. One earlier `support/work-protection-fixture.ts` owner if needed. Shared screen/address helpers have exclusive owners below. | After support prerequisite F; screen and address clusters serial internally. |
| E — resolved revision erasure | Rows E | Permanent erasure of real graph revisions, plus real Work protection where present | **Product API `/v1/erasures`.** Resolve the exact revision's existing owner and kind, admit `erasure.request`, journal and apply its tombstone. A backup or import does not stand in for erasure authority or custody. | 1 support session + 3–5 batches of 2–4 roots; new `support/revision-erasure-fixture.ts`, then read-only reuse. | Resolve identity before changing each root; no undo-erasure cleanup, use fresh cases. |
| C — semantic/context and reviewed effects | Rows C | Real Statements, reviewed identity merge, Poll/Proposal outcomes, Context revision history | **Product command/API.** Owners generate coherent heads, originals, decisions and outbox. Import is not a generic Statement/effect/Context writer. | 3–5 small batches; roots only, optionally distinct `support/statement-fixture.ts` and `support/proposal-fixture.ts`. | Real authored DefinitionRevision pins first; Context history batch conditional on exact recovery equivalence. |
| R — live composition and delivery | Rows R | Structure/generation/placement, progress references, chapter Content publication/eligibility and real stale-head movement | **Product command/API.** Composition and delivery owners preserve placement and publication identity. Import/backup is unnecessary for these small fixtures and does not prove their transitions. | 2 batches; `(ranking-progress, work-serial-projection)` then `(realm-module, realm-submission-targets)`, four roots only; optional distinct `support/composition-delivery-fixture.ts`. | Returned owner IDs and actual erasure/eligibility dependencies; shared media support read-only. |
| O — owner projections and disposal | Rows O | Public text index fixtures, source-credit originals; cleanup of command-created Events or quarantined search | **Product command/API**, with ordinary harness disposal of an owned isolated store. Invoke the existing projector/lifecycle for valid state. No extra mutation is needed to clean a store that QA discards. | 3–5 batches; roots only, optional dedicated `support/source-credit-fixture.ts` and `support/public-content-index-fixture.ts`. | Genuine source proposal/support first; search cleanup roots already isolated. |
| I — catalogue-native credit input | Rows I | Public Work catalogue metadata, native Agent credits and compositions attached to imported Works | **Product's own catalogue import**, `/v1/work-imports` or `/bulk`; normal source/composition APIs complete related owner state. Import determines public metadata/credit provenance. It cannot accept arbitrary RDF or malformed historical originals. | 2–3 batches; roots plus one exclusive `g-937-support.ts` change before its consumers; new import helper only if needed. | Source credit support prerequisite for follows-authors; do not share helper edits with A. |
| B — valid large reader populations | Rows B | Complete Collections, Structures, occurrences/groups, public Work/library owner populations and relation-star degree | **Restore a built backup**, using `createCorpusBackupDriver`. Build each recipe through product operations once; retain all stopped owner stores, restore isolated copies. Repeated per-file reconstruction wastes preparation; product import alone does not carry all dependent owners. | 4 recipe-qualification sessions + 4–6 migration batches (chapter navigation needs two); 8–10 total. Distinct proposed `support/collection-summary-corpus.ts`, `support/chapter-navigation-corpus.ts`, `support/library-corpus.ts`, `support/relation-star-corpus.ts`. | Shared driver stays read-only. Every build/restore independently proves the 600-second full preparation budget; 40k relation build feasibility unknown. |
| M — model-generation lifecycle | Rows M | Old/current generations, custody, immutable-slot reservation and admission race hooks | **Existing model-owner maintenance command is the only supported candidate.** `ensureLocalDatasetModelGeneration` and custody backfill are stopped-store operations. They do not establish the demanded online arbitrary-generation race. Restore cannot switch an in-flight request's generation coherently. | 1 owner-evidence session first; implementation session count **unknown**, not a ready Luna batch. Claim model test roots only after owner settles choreography; maintenance files need separate ownership. | Blocked on real predecessor/artifact provenance and supported race choreography. No new generation writer. |
| X — legacy, corrupt or unsupported state | Rows X, including inherited roots | Missing/contradictory immutable descriptors, absent heads, forged protection, legacy manifests, outbox gaps, arbitrary control cuts and unsafe ownership transfers | **Restore is the sole candidate for genuine retained state**, but **no supported mechanism is established for the full class**. Valid command-built backups cannot create corruption; current import rejects malformed originals. For genuine legacy data, a compatible retained source is a prerequisite. For fault transitions, an owner must preserve the assertion in appropriate fault/native coverage or establish an existing supported transition. | No credible migration-session total. First 4–6 owner-evidence sessions by subgroup below; actual implementation is additional. Never dispatch “one raw helper rewrite” for this class. | Blocked; composite roots last. A valid subset migrated inside a mixed root does not remove that root from the scan. |

`F` is one **support/claim preparation session**, not a second store-shaping
mechanism: establish exact per-batch claims, move scan capability assertions to
existing synthetic scan fixtures where repository examples migrate, and wire
existing authority/erasure services if the current fixture lacks them. Do not
give every batch broad `tests/qa/integration/support/**` or fixture claims.

## Per-file inventory

Each full path below is a member of the 149-root derived scan. `X` means blocked
for the full file, even where a valid subset has an obvious API replacement.
The last column uses the timing evidence notation above. Imported-test wrappers
are assigned to the same limiting mechanism as the tests they execute.

| File | Class | Actual raw write shapes and migration constraint | Before seconds/file |
| --- | --- | --- | --- |
| `services/main/tests/content-projection.integration.test.ts` | X | Deletes/reinserts sealed search-source/receipt descriptors, digests and publication byte digest; replaces/deletes MatchUnit bodies and probes; malformed orphan body. Valid publication/rebuild cannot manufacture those corrupt originals. | E30 |
| `services/main/tests/g-940-summary.integration.test.ts` | B | Inserts Collection, Work/MainVersion, Structure/generation and 19/1,000 placements. Build complete real revisions at both cuts, restore them. | E30 |
| `services/main/tests/management-read.integration.test.ts` | X | Restore hold toggle, removal/reappearance of Realm type, private-chapter placement. Real composition is supported; arbitrary Realm disappearance is not established. | E30 |
| `services/main/tests/outbox.integration.test.ts` | X | Replaces receipt/event ordinal; synthetic empty/broken/duplicate batches, control/stream sequence advance, outbox deletion. Commands retain coherent receipt/event histories. | E30 |
| `services/main/tests/profiles.integration.test.ts` | X | Legacy handle/disclosure deletion, graph erasure markers, nonexistent Rating head then repair, private Agent disclosure and hold. Erasable known revisions are only one subset; profile/head corruption remains. | E30 |
| `services/main/tests/realm-read.integration.test.ts` | X | Synthetic semantic sequence 999999, fabricated erased publication chain, hold/private Space, dangling Concept protection. Concept protection writer is explicitly absent in source. | E30 |
| `services/main/tests/structure-group-root-owner.integration.test.ts` | X | Historical/duplicated Structure anchors, legacy manifests, changed original generation/count, missing/oversized object roots. Genuine legacy cut and separate damage qualification required. | E30 |
| `services/main/tests/work-contents.integration.test.ts` | X | Chapter erasure, large manifests, copied revision/head referencing legacy manifest without topGroups, hold during GC. Current composition authoring does not create missing legacy roots. | E30 |
| `services/main/tests/work-metadata.integration.test.ts` | X | Deletes/reinserts original metadata, private Space, Work-head tombstone. Real erasure/settings fit subsets; destruction of sealed original metadata does not. | E30 |
| `services/main/tests/work-read.integration.test.ts` | X | Source credits, Book/DigitalDocument/isPartOf mutation, Space privacy, fabricated publication, hold and manual epoch/cutover. Need real source and recovery owners; fake publication/control remains unsupported. | E30 |
| `tests/qa/integration/access-author.test.ts` | A | Dangling Work protectionHead. Replace with real tighten protection revision and preserve denied author edit. | E30 |
| `tests/qa/integration/access-avatar.test.ts` | X | Bare PenNameAgent with manually paired Access ownership. Agent provision supports person/organization/service, not this legacy kind. | E30 |
| `tests/qa/integration/access-baseline.test.ts` | X | Synthetic public Work/publication/eligibility/Context; removes eligibility and selection head without withdrawal. Valid publication is insufficient for exact missing-head probe. | E30 |
| `tests/qa/integration/access-managed-organization-api.test.ts` | X | parentOrganization/memberOf/sameAs triples in QA-only graph. Org provision does not supply this descriptive relationship authoring path. | E30 |
| `tests/qa/integration/agent-profile.test.ts` | X | Shared raw Realm/media selection, 300 credit references, required profileDisclosure deletion. Publication APIs fit; profile min-count corruption remains. | E30 |
| `tests/qa/integration/catalog-descriptions.test.ts` | A | Organization type plus separately seeded Access organization. Provision a real organization and use its actual authority identity. | E30 |
| `tests/qa/integration/chapter-seek.test.ts` | B | Historical/current 1k/5k/10k child manifests, exact pins, denial populations, 3k groups and numbering. Supported composition stages build valid cuts for restore. | E30 |
| `tests/qa/integration/classification-bootstrap.test.ts` | X | Incomplete inactive ClassificationContext and hold. Valid bootstrap cannot author the intentionally incomplete preexisting row. | E30 |
| `tests/qa/integration/concept-page.test.ts` | X | Multilingual Concept definitions/broader relation and active Concept with dangling protection. General Concept protection is unestablished. | E30 |
| `tests/qa/integration/content-search-public-title-native.test.ts` | O | Arbitrary MatchUnit publicTitle/searchBody insert/delete. Use real published text/title projection with unique terms; preserve field-predicate assertions. | E30 |
| `tests/qa/integration/content-zone-page.test.ts` | X | Space owner replacement during admission. No supported owner transfer was established; revocation is a different transition. | E30 |
| `tests/qa/integration/content-zone-revision-delivery.test.ts` | X | Space owner replacement during paused private hydration, then reversal. Backup restore is not a specified live ownership-transfer race. | E30 |
| `tests/qa/integration/context-statement-cases.test.ts` | X | COPY/ADD/CLEAR/DROP backup graphs; legacy ClassificationApplications, missing manifests, cancellation/empty batches, discriminator removal, fences and synthetic sequences. Genuine legacy source plus fault-coverage disposition needed. | E30 |
| `tests/qa/integration/discovery-continuous-writes.test.ts` | C | Bare Statement subject edge used by later vote. Author an actual Statement with exact definition/interpretation and returned ID. | E30 |
| `tests/qa/integration/discovery-projection.test.ts` | X | Helper saves/clears/restores graphs and rewrites lineage; type/label/privacy/erasure/hold edits. Fresh isolation removes helper backdoor; exact Concept label and held-state equivalence still need owner proof. | E30 |
| `tests/qa/integration/discovery-rating-effects.test.ts` | X | Synthetic rating/semantic receipts/events, excluded identities, 1k/10k skeletal Works, target-only receipt replacement. Corpus cannot produce forged owner evidence. | E30 |
| `tests/qa/integration/discovery-read-isolation.test.ts` | X | Dynamically executes predecessor tests, discovery projection and card/optional reads. Inherits their actual writes; migrate dependencies first. | E30 |
| `tests/qa/integration/discovery-refresh.test.ts` | O | Five shuffled source AuthorCredit originals/projections. Adopt genuine retained proposals/support through source-author-credit API; preserve order semantics. | E30 |
| `tests/qa/integration/erasure-source-reconcile.test.ts` | X | Deletes graph erasure receipt after real erasure. A pre-erasure backup plus retained ledger is a candidate, but the restored held-cut/reconciliation equivalence is unproved. | E30 |
| `tests/qa/integration/event-query-bounds.test.ts` | O | Only raw write deletes command-created Events in cleanup batches. Keep command fixture; discard isolated owned store instead. | E30 |
| `tests/qa/integration/event-time.test.ts` | X | Deletes/restores EventTime slot without withdrawal proof. Real withdrawal changes the very evidence this failure/recovery case distinguishes. | E30 |
| `tests/qa/integration/export-api.test.ts` | X | Synthetic Structure/partial seal with zero-digest source manifest. Real composition/seal is candidate only after proving equivalent export behavior; no malformed import. | E30 |
| `tests/qa/integration/export-scoped-dependencies.test.ts` | X | Context/Work protection and invalid acceptedFrameDimension. Work protection fits; Context protection and invalid dimension have no admitted writer. | E30 |
| `tests/qa/integration/export-scoped-erased-rating.test.ts` | X | Rating observation ErasedRevision with retained current head. Rating observation is not among the resolver's named graph-erasure kinds; owner proof required. | E30 |
| `tests/qa/integration/feed-group-votes.test.ts` | E | Tombstones actual selected text-contribution draft; Work protection for stale feed. Resolve real draft owner for erasure; use real protection command. | E30 |
| `tests/qa/integration/feed-home.test.ts` | A | Synthetic Zone/Space, Work Book/VideoObject/Prompt/Skill type mutation, protection and hold. Use Space/type/protection owners; held-state case must use actual coordinated restore lifecycle. Conditional batch, not arbitrary hold toggle. | E30 |
| `tests/qa/integration/feed-read-stability.test.ts` | X | Protection plus replyPlacementHead deletion/restoration against retained Realm index. Withdrawal-equivalent owner transition not established. | E30 |
| `tests/qa/integration/follows-authors.test.ts` | I | Source AuthorCredit and NativeAgentCredit originals/projections; manual dirty SQL. Import real native credits, adopt external support, let genuine events dirty projection. | E30 |
| `tests/qa/integration/g-1001-work-cards.test.ts` | X | Global Context state save/delete/restore; 300/3k credit/rating histories, sequence rollback, Agent privacy toggle. Import caps eight native credits per Work; profile disclosure writer absent. | E30 |
| `tests/qa/integration/g-1003-address-navigation.test.ts` | A | Shared helper sets catalogueVisible; dangling Work protection twice. Use valid public catalogue import and real protection; helper owner coordinated with all G-937 consumers. | E30 |
| `tests/qa/integration/g-1011-optional-work-reads.test.ts` | A | Helper moves every active global RatingContext to saved graph, restores and drops it. Fresh isolated product project with own Context removes destructive shared-store preparation. | E30 |
| `tests/qa/integration/g-1016-discovery-refresh.test.ts` | X | Deletes graph outbox twice after Relay handoff. No supported graph-outbox pruning operation established; retention owner decision required. | E30 |
| `tests/qa/integration/g-1019-unnamed-agent.test.ts` | X | Removes current name/format markers, inserts old profileHandle for upgrade. Needs authentic old profile cut, not current command downgrade. | E30 |
| `tests/qa/integration/g-1033-discovery-refresh.test.ts` | X | Realm deletion/retyping as Zone and partial reappearance. Private Realm already uses Space settings; identity corruption does not. | E30 |
| `tests/qa/integration/g-1034-realm-ranking.test.ts` | X | Dynamic import executes agent-profile tests. Inherits profile corruption and shared screen helper; migrate dependency first. | E30 |
| `tests/qa/integration/g-1042-ranking-followups.test.ts` | X | Missing reply placement head, Active/Retired Realm toggles/deletion and dirty index SQL. Real withdrawal/retirement/deletion equivalence unestablished. | E30 |
| `tests/qa/integration/g-1063-cost.test.ts` | X | 100/1k/10k skeletal Works and receipt-less arbitrary event/control advance. Replace event with real owner change only after proving same cost branch. | E30 |
| `tests/qa/integration/g-506-target.test.ts` | E | Erases real unpublished/published draft, semantic Character, Release, Work and composition revisions. These resolver kinds exist; wire exact per-owner erasure authority/custody and fresh cases. | E30 |
| `tests/qa/integration/g-508-role-matrix.test.ts` | X | Removes/reinserts MainVersion selection after admission. Need genuine withdrawal preserving the intended source-role stale test; arbitrary head loss is unsupported. | E30 |
| `tests/qa/integration/g-509-suitability.test.ts` | E | Unrelated anonymous erasure marker. Erase a real unrelated supported revision and preserve unrelated-target behavior; remove undo cleanup. | E30 |
| `tests/qa/integration/g-538-translation-basis.test.ts` | X | Native credit/historical TranslationLink plus eligibility-head deletion/restoration during race. Translation writer and missing-head transition unestablished. | E30 |
| `tests/qa/integration/g-539-semantic-disclosure.test.ts` | X | Forged semantic/Work protection, curator replacement, retirement, 1,024 Collections. Valid collection corpus cannot create generic protection/ownership mismatch. | E30 |
| `tests/qa/integration/g-571-profile-screen.test.ts` | A | Shared helper inserts Space/Realm, media decision, publication slot/selection. Use real Space/media publication and Realm selection; historical SQL screening fixture remains a separate existing concern. | E30 |
| `tests/qa/integration/g-571-screen.test.ts` | A | Same raw publication helper as profile-screen. Migrate both roots and helper in one exclusive batch. | E30 |
| `tests/qa/integration/g-591-contribution-basis.test.ts` | X | Native credit/TranslationLink and eligibility-head deletion/restoration during publication race. Same unsupported rights/history transition as translation-basis. | E30 |
| `tests/qa/integration/g-629-entity-page.test.ts` | X | External unowned Work predicate injection including race; 1,051 Statements/decision slots. Valid Statement corpus fits; arbitrary foreign-owner injection does not. | E30 |
| `tests/qa/integration/g-629-statement-context.test.ts` | X | Removes retained Withdrawn outcome and grafts private Context revision onto Statement. Contradictory retained state is not admitted. | E30 |
| `tests/qa/integration/g-630-zone-routes.test.ts` | A | Work protection, real Work-head erasure, private publication-head replacement. Use real protection/erasure/private publication owners; preserve restricted versus unavailable envelope, conditional on exact publication transition. | E30 |
| `tests/qa/integration/g-650-resource-targets.test.ts` | E | Erases chapter's actual composition revision returned by composition change. Resolve Structure owner and apply real erasure; retain all reply suppression projections. | E30 |
| `tests/qa/integration/g-652-target-reviews.test.ts` | X | Deletes/restores Rating observation head to demand 503 instead of incomplete aggregate. Healthy observation command cannot produce missing head. | E30 |
| `tests/qa/integration/g-704-contribution-loop.test.ts` | C | Character mergedInto plus membership repair. Use reviewed editorial proposal/review/decision merge and genuine owner receipts. | E30 |
| `tests/qa/integration/g-824-library-traversal.test.ts` | X | 1k public Works, missing label and second MainVersion, subject cleanup/backfill faults. Healthy backup solves scale, not conflicting MainVersions. | E30 |
| `tests/qa/integration/g-828-zone-browse.test.ts` | X | 1k Realm selected Works, missing selection, synthetic dataset sequence 1002/Relay batches. Real population cannot reproduce chosen artificial chronology. | E30 |
| `tests/qa/integration/g-829-public-reads.test.ts` | X | Reversible forged semantic protection/erasure, uncommitted definition and extra ambiguous head. G-1637 demonstrates proof invalidation; native denial must survive. | 28.6 diagnostic |
| `tests/qa/integration/g-833-realizations.test.ts` | X | Historical translation-link-v1 with unresolved source revision. Authentic old retained import/backup required; current translation surface found is read-only. | E30 |
| `tests/qa/integration/g-836-sao-public-api.test.ts` | I | Catalogue flags plus synthetic Book Structure/progress state around reviewed merge. Own import creates public Works; composition API creates valid generation/placements. | E30 |
| `tests/qa/integration/g-845-wiki-intake.test.ts` | X | SKOS-XL nameRecord literalForm. No product writer for this exact stored-name representation established; ordinary alias would drop the branch. | E30 |
| `tests/qa/integration/g-851-release-query.test.ts` | X | Release-v2 downgrade, 620 public/release/Realm bundles, synthetic read-race sequence and 200 platform edits. Authentic legacy provenance and race disposition required. | E30 |
| `tests/qa/integration/g-854-large-library.test.ts` | B | Large public Work/MainVersion/contribution/publication graph plus library SQL rows. Build matching real graph/library owners once, retain and restore. | E30 |
| `tests/qa/integration/g-856-discovery.test.ts` | X | Imported g-851-release-query tests execute all their legacy/race writes. Dependency first; no second migration. | E30 |
| `tests/qa/integration/g-856-library.test.ts` | B | Imports large-library plus nonraw library suites. Canonical corpus migration removes transitive raw writes. | E30 |
| `tests/qa/integration/g-856-readers.test.ts` | X | Imports g-920-wiki-readers tests. Inherits deliberate corrupt/global-state probes. | E30 |
| `tests/qa/integration/g-892-collection-grain.test.ts` | X | Forged Work and Collection protection. Work title protection exists; generic Collection protection does not establish an admitted writer. | E30 |
| `tests/qa/integration/g-911-catalogue-names.test.ts` | X | Removes publicTitle projection for backfill and catalogue/selection facts for stale index. Needs genuine old cut and supported withdrawal, not deleting derived rows. | E30 |
| `tests/qa/integration/g-920-wiki-readers.test.ts` | X | Refused default-graph update, Global withdrawn/malformed facts/deletion, hold toggles. Transport/native corrupt-state coverage cannot be relabeled a normal command fixture. | E30 |
| `tests/qa/integration/g-929-wiki-disclosure.test.ts` | X | Wiki property-claim StatementRevision tombstone and Work protection. Wiki apply uses Statement owner for property claims; erasure resolver does not recognize StatementRevision. Work protection fits only the second subset. | E30 |
| `tests/qa/integration/g-930-merge-authority.test.ts` | X | Reversible catalogueVisible changes in proposal/review/native race. No equivalent reversible catalogue visibility transition established. | E30 |
| `tests/qa/integration/g-935-rating-language.test.ts` | X | Context downgrade to v1 and current language tag conflicting with retained state. Authentic v1 provenance plus language-corruption coverage required. | E30 |
| `tests/qa/integration/g-937-creation.test.ts` | I | Shared/ad hoc catalogueVisible on Works. Use own catalogue import; retain separate private-Work behavior. | E30 |
| `tests/qa/integration/g-937-migration.test.ts` | X | Public flag, legacy Zone manifest/defaultRealm/handles/routes, invalid anchor and hold. Authentic graph/object/owner backup plus corrupt-binding disposition required. | E30 |
| `tests/qa/integration/g-937-scopes.test.ts` | X | Public flag, synthetic Person head/profile, foreign Space ownership, profileDisclosure toggle. Real provision covers valid identities, not graph profile privacy mutation. | E30 |
| `tests/qa/integration/g-937-zone.test.ts` | A | Public flag and reversible Space/Zone disclosure. Import real public Work, use owning Space settings; Zone disclosure copy is nonauthoritative and needs no independent writer. | E30 |
| `tests/qa/integration/g-991-owner-migrations.test.ts` | X | Legacy Zone immutable manifest/routeSegment and migration fences. Current creation does not author old immutable representation. | E30 |
| `tests/qa/integration/g-992-platform-name-repair.test.ts` | X | Legacy reserved support/admin aliases and deleted migration marker. Current aliases deliberately reject these states; retained old provenance needed. | E30 |
| `tests/qa/integration/hub-api.test.ts` | X | Prompt/Skill typing, synthetic publication pointers and corrupt digest. Hub import handles valid content, not wrong committed byte digest. | E30 |
| `tests/qa/integration/identity-links.test.ts` | X | Synthetic Structure/generation and orphan placement on unrelated retired generation. Current composition cannot author this orphan original. | E30 |
| `tests/qa/integration/library-copies-loans.test.ts` | X | Forged Person protection/private graph profile. Preference privacy is not the same missing/protected graph state. | E30 |
| `tests/qa/integration/library-status.test.ts` | X | Observation erasure/undo, missing head/repair and Work merge redirect. Real merge fits; undo-erasure and missing observation head remain unsupported. | E30 |
| `tests/qa/integration/main-selection-languages.test.ts` | X | Draft tombstone, legacy singleton Main manifest, Book type, COPY/replay/restore graphs. Authentic legacy backup replaces graph copies; current commands do not downgrade manifest. | E30 |
| `tests/qa/integration/media-summary-disclosure-release.test.ts` | A | Realm publication slot/selection adopting Main selected content. Create actual Realm selection with exact decision/contribution and authority. | E30 |
| `tests/qa/integration/member-reply-api.test.ts` | E | Tombstones real root text-contribution draft after reply edits. Erasure resolver supports this kind; provision its owner erasure authority. | E30 |
| `tests/qa/integration/membership-seek.test.ts` | X | Legacy unnormalized 3k placements/9 removals/20k unrelated triples, proof forgery/deletion HTTP probes and deliberate position corruption. Commands create normalized membership; keep native proof-denial/repair coverage. | E30 |
| `tests/qa/integration/model-custody-backfill.test.ts` | M | Old generations/head/receipt/outbox, old pinned revision with missing custody, later bootstrap updates. Genuine retained model/artifact lineage needed; offline backfill cannot invent absence provenance. | E30 |
| `tests/qa/integration/model-generation-refusal.test.ts` | M | Deletes/replaces generations/receipts/outbox, reserved orphan slots, artificial old generation and online race, captured-triple restoration. Existing offline maintenance is not an online race writer. | E30 |
| `tests/qa/integration/onboarding-concepts.test.ts` | X | Work Book/Recipe types, dangling Concept protection and unaccepted classification population. Valid proposals/types fit APIs; Concept protection remains unestablished. | E30 |
| `tests/qa/integration/owner-operations.test.ts` | C | Synthetic Context current/retained manifest then advances current original to test recovery. Use real Context creation/revision history preserving both manifests; exact recovery-kind equivalence is conditional. Existing object corruption cases are outside raw-update replacement. | E30 |
| `tests/qa/integration/owner-outbox-recovery.test.ts` | X | Empty synthetic batch and direct dataset/Main stream sequence advance. Cancellation's zero-event command is not equivalent Main-stream provenance. | E30 |
| `tests/qa/integration/owner-relay-gap.test.ts` | X | Deletes committed batch/event for OutboxGap. Genuine commands and valid backups retain complete source history. | E30 |
| `tests/qa/integration/podcast-playlist.test.ts` | X | Membership downgrade to rv:target, ItemList deletion and invalid MemberRole→PartRole. Current Collection commands cannot author legacy/invalid representation. | E30 |
| `tests/qa/integration/post-author-notes-custody.test.ts` | X | Deletes/restores Post head and toggles hold. Healthy Post commands do not manufacture arbitrary absent head. | E30 |
| `tests/qa/integration/post-lifecycle.test.ts` | X | Rewrites immutable receipt outputs/Post originals to legacy chapter Work/MainVersion, synthetic placement batches and partial receipts, later missing-receipt insertion. Needs genuine pre-Post graph/Access/object backup. | E30 |
| `tests/qa/integration/post-search-disclosure.test.ts` | A | Inserts/removes orphan Work protection on Books during chapter search. Use actual Work protection tighten/relax; prove parent-hidden OPTIONAL envelope is preserved. Conditional equivalence check. | E30 |
| `tests/qa/integration/private-original-source.test.ts` | X | Zero-digest edit receipt, deleted edit/create receipts. Preserve RevisionCorrupt/RevisionNotFound; no valid creation/edit/import produces damaged immutable provenance. | E30 |
| `tests/qa/integration/proposal-execution.test.ts` | C | Synthetic adopted Proposal/closed Poll/resolution and effect digest/capability/state. Real proposal-bearing poll, ballot/closure/resolution lifecycle supplies these witnesses. | E30 |
| `tests/qa/integration/publication-selection-members.test.ts` | E | Tombstones actual TextContribution draft to refuse selection. Resolve contribution owner, journal real draft erasure and retain refusal. | E30 |
| `tests/qa/integration/query-templates.test.ts` | E | Erases actual Work head used by query fixture (not an arbitrary template DefinitionRevision). Resolve Work owner; keep existing query population/projection/budget assertions. | E30 |
| `tests/qa/integration/ranking-progress.test.ts` | R | Minimal Structure→MainVersion triples. Create real composition and use returned Structure in progress store/replay. | E30 |
| `tests/qa/integration/rating-components.test.ts` | X | Deletes/restores observation heads alongside legacy SQL value/component reconstruction. Current Rating command cannot produce existing observation with absent head. | E30 |
| `tests/qa/integration/rating-own-target.test.ts` | X | Orphan protection on refusing Context, hidden/absent equivalence. No generic Context protection operation established; preserve error ordering. | E30 |
| `tests/qa/integration/rating-question-presentation-retire.test.ts` | X | Orphan presentation protection to alter language capacity. Draft/review/retire is not proof of protected-hidden presentation state. | E30 |
| `tests/qa/integration/rating-question-presentation.test.ts` | M | Deletes/replaces model generation/receipt, old generation and reserved orphan slots, online bootstrap race and captured-triple restore. Offline maintenance cannot reproduce whole race. | E30 |
| `tests/qa/integration/rating-release-target.test.ts` | O | Raw restoreHold removal after restored graph replay, separate Access release. Use releaseRestoredGraphHold with exact recovery/deletion evidence and coordinated graph/Access release. | E30 |
| `tests/qa/integration/read-stability.test.ts` | E | Fake ContentVariant pin to invented erased revision. Replace with actual published/pinned Content and real erasure, preserving discovery cursor exclusion/retirement assertions. Conditional equivalence check. | E30 |
| `tests/qa/integration/realm-create.test.ts` | X | Multilingual bare Concept plus old Space/Realm lacking modern originals. Vocabulary/Space APIs fit modern subset; legacy read needs authentic retained cut. | E30 |
| `tests/qa/integration/realm-directory.test.ts` | X | Vocabulary/topic edits, fake erased pin, Space privacy, 129/384 skeletal Realms, synthetic visibility receipt/sequence and hold. Settings/valid corpus fit subsets; forged chronology/pin does not. | E30 |
| `tests/qa/integration/realm-module.test.ts` | R | Structure/generation/chapter placement and ContentVariant/publication/eligibility plus erasure. Build actual composition and Content lifecycle; use returned exact references. | E30 |
| `tests/qa/integration/realm-profile.test.ts` | A | Moderator/outsider Agent type triples after SQL member setup. Provision real Agents and use returned actor IDs. | E30 |
| `tests/qa/integration/realm-submission-targets.test.ts` | R | Chapter placement/removal/undo, missing eligibility, arbitrary Work-head replacement for stale submission. Use genuine composition changes, nonpublic eligibility and content edit to produce supported stale state. Prove same exclusion/refusal. | E30 |
| `tests/qa/integration/recipe-structure.test.ts` | X | Removes ListItem/item/position projections from populated Recipe before membership normalization/idempotence. Commands author normalized state; authentic old Recipe backup required without silently normalizing before tested operation. | E30 |
| `tests/qa/integration/relation-star-cost.test.ts` | B | 40k relation occurrences/heads with hub/leaf participation at 1k/10k/40k cuts. Build genuine definitions/participants/occurrences once; validate equivalent guard degree and 600-second preparation feasibility. | E30 |
| `tests/qa/integration/scoped-judgments.test.ts` | X | ContextSemanticRevision tombstone then undo. Context writer emits ContextSemanticRevision/RevisionAnchor, not SemanticRevision; current erasure identity query does not recognize this owner kind. No generic tombstone API or undo. | E30 |
| `tests/qa/integration/search-card-fields.test.ts` | X | Agent profileDisclosure→Private. Agent profile input has no disclosure field; preferences are a different owner surface. | E30 |
| `tests/qa/integration/search-card-rich.test.ts` | A | Work title and sequence change inside first card-read hook. Use genuine metadata/content edit with current head, authority and bounded hook; preserve retry/live-title checks. | E30 |
| `tests/qa/integration/search-chapter-book.test.ts` | O | Raw anchor reinsertion only in finally after genuine quarantine/clear/replay/verify. Already isolated: remove cleanup and let QA discard/reset store. Do not forge offline activation evidence. | E30 |
| `tests/qa/integration/search-graph-sentinel.test.ts` | X | Arbitrary named-graph searchBody/sentinel, body-only deletion, final deletion. Native text-index invariant is not an admitted product graph fixture; preserve in native/owner coverage. | E30 |
| `tests/qa/integration/search-grouped-native.test.ts` | X | Shared reference-disclosure helper inserts Works/semantics/Space/Zone/protection and forged/ambiguous creation receipts. Real APIs fit healthy records, not deliberate duplicate receipt provenance. | E30 |
| `tests/qa/integration/search-statement-query.test.ts` | X | Replaces control/epoch/index, skeletal contexts/search/Statement/rating populations; missing decision kind, sense-head replacement, same immutable decision outcome mutation/withdrawal. Real joined-query transitions need separate corrupt-state disposition. | E30 |
| `tests/qa/integration/search-studio-chapter-content.test.ts` | O | Raw anchor cleanup then membershipPrepare to repair its invalidation. Already isolated: remove both compensating cleanup steps, keep quarantine verification and harness reset. | E30 |
| `tests/qa/integration/semantic-generation.test.ts` | M | Replaces active generation/manifest/predecessor and advances control inside activation hook. Existing stopped-stack maintenance cannot be substituted for online generation race. | E30 |
| `tests/qa/integration/source-authenticated-api.test.ts` | X | Shared source-support helper alters/restores immutable conversion title, demanding 503 for reads/replay. A normal new Source revision is not equivalent corrupt original evidence. | E30 |
| `tests/qa/integration/source-author-credit.test.ts` | A | Orphan Work protection insert/delete around credit refusal. Use actual Work title protection and preserve refusal; exact protection/credit equivalence is a proving requirement. | E30 |
| `tests/qa/integration/statement-disclosure.test.ts` | C | Bare foreign Work, ListItem, Release/Realization and rdf:Statement frame-score populations. Create actual resources/positions and authored Statement applicability; prove exact 16/17/33 frame behavior. Block a subcase if no owner produces required realization. | E30 |
| `tests/qa/integration/structure-qualifier-root.test.ts` | X | Old record/order-tree manifest with missing qualifier root and synthetic sequence-7 StructureRevision. Modern writer creates current roots; authentic old immutable checkpoint required. | E30 |
| `tests/qa/integration/sys-receipt-relay-gap.test.ts` | X | Deletes/reinserts receipted batch/event snapshots, repeating hole in cleanup. Same-head physical outbox hole is not valid stopped backup or admitted command history. | E30 |
| `tests/qa/integration/tag-proposal-api.test.ts` | X | Unrelated skeletal ContextSemanticRevision and candidate-cap+1 identical-label Realm AuthorTagConcepts. Real Context fits; exact duplicate AuthorTagConcept provenance/overflow builder is unestablished, ordinary proposal may reuse concepts. | E30 |
| `tests/qa/integration/translated-work-links.test.ts` | X | Legacy exact/unresolved TranslationLinks, official/third-party status, evidence/scope/epoch/pinned target. Reads/reconciliation are not a new authoring/import writer; retained envelope provenance needed. | E30 |
| `tests/qa/integration/typeahead-cards.test.ts` | X | Agent profileDisclosure public→private. Same unsupported profile visibility transition as search-card-fields. | E30 |
| `tests/qa/integration/validation-command.test.ts` | X | CLEAR store/control/receipts/outbox, invented lineage, example.org Work fixture and same-head absent-slot insertion. Preserve native rollback/profile/focus/guard outcomes in owner/native suite; no arbitrary product envelope backdoor. | E30 |
| `tests/qa/integration/validation-cross-profile.test.ts` | X | CLEAR/bootstrap synthetic lineage; partial Context, old RouteBinding, fake Work and dual type/DecisionSlot seeds. Native canonical/cross-profile validation inputs are not current valid product corpus. | E30 |
| `tests/qa/integration/work-address-api.test.ts` | A | Shared catalogueVisible helper and merge chain A→B→C→D. Genuine public import/selection plus reviewed commandWorkMerge; helper migration prerequisite shared with G-937 cluster. | E30 |
| `tests/qa/integration/work-continuities.test.ts` | X | Changes semanticWork owner mapping and clones occurrence IDs sharing one immutable head for scan exhaustion. Valid relation corpus may test crowded scan, but exact forged identity/owner case needs coverage decision. | E30 |
| `tests/qa/integration/work-derivation.test.ts` | C | Legacy exact/unresolved WorkDerivation kind/sequence/corrects declarations. Existing createAdmittedWorkDerivation supports legacy kind scope and genuine admission; preserve reader compatibility without wrapper. | E30 |
| `tests/qa/integration/work-serial-projection.test.ts` | R | Structure/MainVersion/generation and public/private chapter placements. Create through composition APIs; fabricated SQL relay delivery is a separate proof limitation to disclose and address if authentic replay is claimed. | E30 |
| `tests/qa/integration/zone-document-home.test.ts` | X | Space steward swap, missing Main selection and deleted immutable page binding. Steward transfer and damaged publication original are not supported by valid Zone creation. | E30 |
| `tests/qa/integration/zone-presentation.test.ts` | X | Replaces v2 presentation and immutable manifest with prepared v1 state. Needs genuine old Zone/objects checkpoint; no current revision rewrite. | E30 |
| `tests/qa/integration/zone-published-metadata.test.ts` | X | Space owner swap during publication fence while controller stays, SQL permission revocation. Preserve stewardship-versus-controller distinction; transfer writer unestablished. | E30 |
| `tests/qa/integration/zone-realm-attachment.test.ts` | X | 49/63 synthetic attached Zone/Space/receipt populations plus unreceipted defaultRealm decoys. Valid attached corpus fits backup; atomic configuration cannot produce deliberate decoy provenance, so whole root remains blocked. | E30 |
| `tests/qa/integration/zone-route-keyed.test.ts` | X | Collection public→private during mounted read, then undo. Creation-time privacy does not prove live transition; Collection change disclosure writer unestablished. | E30 |
| `tests/qa/integration/zone-showcase-disclosure.test.ts` | X | Extends sealed Realm Space creation receipt with Zone output; changes nonauthoritative Zone disclosure copy. Use real creation provenance for healthy subset; stale visibility probe requires owning Space semantics and assertion review. | E30 |

The tally is **A 15, E 8, C 6, R 4, O 6, I 3, B 5, M 4, X 98**.
That is 47 API/import/valid-corpus candidates, some explicitly conditional,
and 102 roots needing model or retained/adversarial-state decisions. It is
not a claim that 47 files already pass after a substitution.

## Concrete Luna execution and proving checks

All proposed new `support/` paths in this report mean
`tests/qa/integration/support/`. Existing top-level integration helpers and
`tests/qa/fixtures/` paths below retain their actual locations. Claim only the
named batch roots and any named helper that the batch must edit. A file
outside the old G-1636 glob needs an explicit manager claim expansion; that
old glob covers `g-*.test.ts`, not all the ordinary roots in this inventory.

Each implementation session follows the same completion condition: retain
the acceptance behavior, denied/stale/concurrent/partial/recovery checks
present in its roots; remove **all reachable** raw writes for its migrated
roots; prove absence through the derived scan; record before/after seconds
from the same harness, separately identifying startup/preparation and test
work. Partial removal inside an X root is not a migrated root.

Run only changed proving files via
`bun scripts/goal/goalctl.ts test <named files>`, together with the existing
`scripts/qa/raw-sparql-integration-files.test.ts` and
`scripts/qa/raw-update-scan.test.ts` when their examples/expectations change.
Then the affected workspace typecheck, changed-directory type-aware lint and
changed-file ast-grep scan required by the worker protocol. Do not run a whole
tier. Neighboring owner proofs listed below are **manager qualification**
unless included explicitly in the session's claim. This analysis ran none
of those checks.

### F — support and claims, one session before dependent batches

1. Assign exclusive helper owners using the dependency table below. Keep the
   scanner derived, with its import-time no-scan behavior and shrinking
   ceiling. The scan test currently assumes named repository examples remain
   raw; move those positive capability examples into its existing temporary
   integration-root construction when those actual examples migrate. Do not
   weaken import-following or raw-HTTP detection to make the list shrink.
2. Establish only the existing services a ready batch needs: real provisioned
   actors, exact Work/protection/control basis, and complete ErasureService
   owner pools. Prefer per-capability helpers over a new universal fixture
   writer. Claim shared `media-support.ts` or `tests/qa/fixtures/author-credit.ts`
   only if truly necessary and separately from root batches.
3. Coordinate any isolation declarations in
   `scripts/qa/isolated-integration-files.ts` with one owner. Isolation removes
   inappropriate cross-file population sharing; it does not authorize raw
   writes or change the assembler contract.

**Prove:** existing `scripts/qa/raw-update-scan.test.ts`,
`scripts/qa/raw-sparql-integration-files.test.ts`,
`tests/qa/unit/integration-shards.test.ts`; extend these existing files for
the actual migrated/reset populations. No new inventory or scheduler.

### A — small identity/publication/protection batches

Use five to eight batches: (1) `catalog-descriptions`, `realm-profile`;
(2) `access-author`, `source-author-credit`, `post-search-disclosure`;
(3) the two G-571 screen roots and `media-summary-disclosure-release`;
(4) address consumers `g-1003-address-navigation`, `g-937-zone`,
`work-address-api` after I's common helper change;
(5) `g-1011-optional-work-reads`, `search-card-rich`.
`g-630-zone-routes` and the large `feed-home` root require one to three
additional batches after their conditional lifecycle proof.

1. Provision typed Agents/Organizations with `POST /v1/agents`, not graph-only
   type assertions. Use returned identity and actual Access ownership.
2. Tighten/relax Work protection through
   `POST /v1/work-title-protections`, with current Work/control/protection heads,
   fixed rule revision and proper reviewer/signing dependencies. Preserve
   author-credit/edit refusal and public hidden-parent envelope assertions.
   A dangling pointer is not itself retained as the fixture coordinate.
3. Create Space/Zone or Realm with `POST /v1/spaces`; publish actual media
   Content and select through `/v1/publication-selections`. Keep exact bytes,
   Content decisions and scope. The historical SQL screening job setup is
   existing separate coverage, not evidence that modern uploads use it.
4. Use `GET/PUT /v1/spaces/:space/settings` for Space visibility; Zone readers
   use that owning Space. `PUT /v1/zones/:id/configuration` has no disclosure
   patch, and a new Zone disclosure setter would be a second owner decision.
5. Replace optional-read global Context save/delete/restore with a fresh
   isolated product stack and only its intended API-created Context. Replace
   card-read title/sequence mutation with real metadata edit inside the bounded
   hook, preventing recursive hook invocation. Use returned heads.
6. For Feed Home and G-630, prove each intended type/private-publication/held
   transition with its existing owner before removing the shortcut. If actual
   coordinated restoration cannot fit the file's job, hand off that subcase;
   do not implement a freely toggled restoreHold helper.

**Prove:** every named migrated root. New helper proof, if introduced:
`tests/qa/unit/work-protection-fixture.test.ts` covers exact-basis/authority
setup, while the real integration roots retain denial and concurrency.
`services/main/src/routes/protection.ts`, `modules/protection/work.ts`,
`routes/agents.ts`, `routes/realm-admin.ts` and `modules/zone/configuration.ts`
are the source contracts, not tests to rewrite.

### E — one real erasure owner, independent targets

1. Reuse `tests/qa/integration/erasure-revision-kinds.test.ts` as the concrete
   integration fixture pattern: ErasureService with Relay/Content/Access pools,
   `access:manage` assertion, `erasure.request` grant on `erasure:<resource>`,
   UUID of the exact graph revision and its true owner.
2. The input profile name remains `content-revision-erasure-v1`, but
   `modules/erasure/revision-kind.ts` resolves Content, text-contribution draft,
   semantic resource, Release, Work head and composition. It does **not**
   authorize arbitrary DefinitionRevision, Rating observation, StatementRevision,
   ContextSemanticRevision, Agent or nonexistent revision tombstones. G-506's
   composition revision belongs to the Structure, not the occurrence ID.
3. First batch: `g-506-target`, `g-650-resource-targets`, `member-reply-api`.
   Second: `feed-group-votes`, `publication-selection-members`.
   Third: `g-509-suitability`, `query-templates`. Fourth conditional:
   `read-stability`; build actual Content pin before erasing. G-929's property
   claim is a StatementRevision, not a semantic resource revision, and remains
   X. Unknown identity must remain refused.
4. Verify journal, graph receipt, tombstone and existing public suppression;
   preserve replay, wrong-owner, unknown-target and denied behavior. Never
   remove a tombstone to restore a case. Separate targets/cases or disposable
   projects preserve follow-on assertions without un-erasure.

**Prove:** named changed roots; existing
`services/main/tests/erasure-revision-kinds.test.ts` and
`tests/qa/integration/erasure-revision-kinds.test.ts` are manager references.
If new helper introduced, name its proof
`tests/qa/unit/revision-erasure-fixture.test.ts`; real owner admission/tombstone
proof stays in integration. The scoped-judgments Context tombstone is X,
not an additional arbitrary kind smuggled through this helper.

### C — authentic semantic and reviewed-effect fixtures

1. In `discovery-continuous-writes` and `statement-disclosure`, create actual
   resources/positions and Statements through `/v1/statements` with authored,
   exact relation/interpretation revisions. G-1639's pin findings still apply;
   bare random relationDefinition is not a replacement fixture. Preserve
   relevance/local delta and the 16/17/33 applicability-frame checks.
2. In `g-704-contribution-loop`, use the existing editorial identity proposal,
   review and decision flow to establish mergedInto. Retain exact survivor,
   progress and membership proof; remove compensating raw-write preparation.
3. In `proposal-execution`, create a proposal-bearing poll through `/v1/polls`,
   actual charter/electorate/authority, opening, affirmative ballots, closure
   and resolution. Retain exact effect capability/digest/expected-state
   mismatches and refused execution, instead of planting a resolved Poll.
4. In `work-derivation`, call the existing
   `createAdmittedWorkDerivation` owner with real Account/Access admission,
   target head and legacy kind scope. Its supported exact/unresolved/corrects
   reader meanings need no new compatibility layer.
5. In `owner-operations`, create and revise a real Context retaining both
   immutable manifests. First prove its recovery reader resolves the same
   original kind and expected unavailable/corrupt/matched behavior. If not,
   classify this root X rather than fabricating old contextProfile originals.

**Prove:** all six named roots; manager references
`services/main/tests/proposal-execution.test.ts`,
`tests/qa/unit/work-derivation-replay.test.ts` and G-1639's existing
`services/main/tests/immutable-object-cache.test.ts`. If needed, new
`tests/qa/unit/statement-fixture.test.ts` checks exact definition bindings;
integration retains the actual admission decisions.

### R — current compositions and delivery, two sessions

1. First migrate `ranking-progress` and `work-serial-projection`: create
   composition and actual public/private placements through
   `/v1/compositions` and `/:id/changes`; pass returned Structure/occurrence
   IDs to progress/projection readers. Keep existing replay, epoch and
   rollback assertions. If the SQL-delivered-event fixture is retained,
   disclose that it proves reader reconstruction, not authentic producer
   delivery; use real owner events where that is the acceptance claim.
2. Then migrate `realm-module` and `realm-submission-targets`: actual Content
   drafts/publication/search eligibility, actual composition remove/reinsert,
   real head-changing edit for stale submission, and supported erasure.
   Preserve private-chapter filtering, removed occurrence suppression,
   eligibility movement and stale admission. Do not replace a required fault
   result with ordinary empty success.

**Prove:** those four exact existing roots and scanner absence. If a shared
adapter is introduced, name its narrow check
`tests/qa/unit/composition-delivery-fixture.test.ts`; no product schema change
or structure-specific fixture writer.

### O — genuine projection and owned-store cleanup

1. `content-search-public-title-native`: create unique title/body through real
   publication and run the existing projection owner; retain native text
   field/join assertions on the actual public MatchUnit. No arbitrary QA graph.
2. `discovery-refresh`: source observations/conversions/proposals/support must
   be real, then `/v1/works/:id/source-author-credits` adopts them. Preserve
   shuffled ordinal semantics; verify output/event sequence from genuine
   receipts. Source fixture helper can be built first and reused by I.
3. `event-query-bounds`: keep its existing command-created Events, delete raw
   cleanup and let the isolated file/store lifecycle dispose of them. Declare
   isolation only if current exact-population requirements need it.
4. `search-chapter-book`, `search-studio-chapter-content` are already isolated.
   Delete finally's raw search-anchor reinsertion and consequent manual
   membership repair. Keep quarantine/clear/replay/verification assertions.
   Full `activateRebuiltPublicContentSearch` requires stopped Fuseki and actual
   offline `jena.textindexer` digest; do not invent that evidence in cleanup.
   Full activation remains the rebuild owner's existing proof.
5. `rating-release-target`: replace raw graph/Access hold release with
   `releaseRestoredGraphHold`, using real cut/recovery/deletion qualification.
   Preserve hold-closed refusal and coordinated release; if its restored
   fixture lacks proof, resolve that existing lifecycle prerequisite first.

**Prove:** these six exact existing roots. Existing manager reference:
`tests/qa/integration/content-search-rebuild.test.ts`;
`tests/qa/fault-recovery/search-rebuild-interrupted.test.ts` remains outside
ordinary root migration. New helpers, if needed, have focused
`tests/qa/unit/source-credit-fixture.test.ts` and
`tests/qa/unit/public-content-index-fixture.test.ts` checks.

### I — product catalogue input, shared address helper first

1. Claim `g-937-support.ts` exclusively. Its `work()` currently source-adopts,
   adds catalogueVisible and repairs membership. Replace with the real public
   catalogue/import owner flow while retaining any source-adoption identity
   semantics consumers assert. Import is not permission to discard tested
   correspondence/alias history. If those coordinates cannot coexist through
   existing owners, report that conflict rather than silently changing jobs.
2. `/v1/work-imports` and `/v1/work-imports/bulk` are the actual routes in
   `routes/works-import.ts`, with platform catalogue-import exposure and stable
   item keys. Provision needed actor/grant; use admitted input, at most eight
   native credits per Work and at most 128 bulk items. The nonexistent
   `/v1/works/import` spelling is not an implementation instruction.
3. Migrate `g-937-creation`, then the A address roots after shared helper lands.
   Migrate `follows-authors`: native credits via own import, real source-credit
   adoption for external authors, remove manual dirty-index SQL and consume
   genuine outbox. Migrate `g-836-sao-public-api`: import public Works and create
   their actual Book composition/progress witnesses through normal owner APIs.

**Prove:** these three I roots plus changed address helper consumers as claimed;
do not claim X consumers are complete merely because their helper shrinks.
If needed, new `tests/qa/unit/catalogue-credit-fixture.test.ts` checks exact
credit limits/identity coordinates; real import denial/replay stays integrated.

### B — four bounded public corpus recipes

1. Reuse `prepareWorkProfileCorpus` / `restoreWorkProfileCorpus` and
   `createCorpusBackupDriver` unchanged. Recipes build through public owner
   operations, verify actual dimensions and sampled exact originals, quiesce
   writers, retain stopped graph/SQL/object owners, restore separate targets,
   migrate owners, verify readiness and public smoke read, then stop copies.
   The existing example is `profile-corpus-restore.test.ts`.
2. Collection summary: real Collection and 19/1,000 actual placements,
   complete Work/MainVersion/revisions. Root `services/main/tests/g-940-summary.integration.test.ts`.
3. Chapter navigation: separate supported composition cuts at 1k/5k/10k,
   historical and changed fixed pins, 3k groups and numbering. Use existing
   staged composition pages (256 entries/page), not enormous repeated insert
   changes. Preserve denied candidates and exact neighborhood/navigation
   boundaries. Root `chapter-seek.test.ts`, two migration batches.
4. Library: real public Work/contribution/selection corpus and matching library
   owners/actors; preserve statuses/private boundaries. Root
   `g-854-large-library.test.ts`; wrapper `g-856-library.test.ts` becomes
   scan-clean through the canonical root.
5. Relation star: real readable hub/leaf participants, exact relation definition
   and 1k/10k/40k occurrences. Retain each checkpoint, verify guard degree and
   bounded read behavior. Root `relation-star-cost.test.ts`. Do not count its
   currently missing originals/participants as a valid cheap build benchmark.
6. Never treat `task fixture:build`'s bulk owner serialization as proof of
   authentic command population. This class specifically uses the public
   corpus recipe and shared stopped-backup driver. No second per-class volume
   copier, graph COPY helper, or restore lifecycle.

**Prove:** the five B roots, new capability-named recipe checks
`tests/qa/unit/collection-summary-corpus.test.ts`,
`tests/qa/unit/chapter-navigation-corpus.test.ts`,
`tests/qa/unit/library-corpus.test.ts`,
`tests/qa/unit/relation-star-corpus.test.ts`. Existing manager references:
`tests/qa/integration/profile-corpus-restore.test.ts`,
`tests/qa/unit/catalogue-backup.test.ts`,
`tests/qa/unit/g-1024-corpus.test.ts`,
`tests/qa/unit/g-1031-corpus-deadline.test.ts`,
`tests/qa/unit/g-1045-corpus-schema.test.ts`. Prove identities/history across
two independent restored copies and unsuccessful/resumed preparation as well
as manifest coordinates. Stop source/restore writers correctly on failure.

### M and X — evidence sessions before migration

M: inspect the four named roots together against
`scripts/datasets/model-bootstrap.ts`, semantic model custody and native
generation admission. The current owner fences/stops local storage and applies
a reviewed exact predecessor/artifact maintenance intent; it is not a general
online test writer. Establish real retained older artifact provenance and
how the existing owner can move a generation between stage and admission
without inventing another mechanism. Occupied-slot/corrupt-original probes
need explicit native/fault coverage. Preserve MODEL21/22 generation_changed,
no-new-write, terminal replay and reservations. Proving roots are exactly
`model-custody-backfill`, `model-generation-refusal`,
`rating-question-presentation`, `semantic-generation`; no new online model
update route or fake bootstrap.

X: four to six **evidence/coverage sessions**, not implementation promises:

- Authentic old immutable formats: Structure groups/qualifiers, Recipe and
  playlist membership, Post chapters, Main singleton, Zone aliases/presentation,
  profile format and TranslationLink/Release-v2. Name a retained source,
  creator/version/model/owner cut and restore compatibility. For preparation
  tests, prove restore has not already performed the very normalization being
  tested. The normal driver runs owner migrations; bypassing those silently
  would invalidate the experiment. Representative proving roots:
  `structure-group-root-owner.integration.test.ts`, `recipe-structure.test.ts`,
  `post-lifecycle.test.ts`, `g-991-owner-migrations.test.ts`.
- Missing/corrupt immutable originals and source/outbox histories: receipt
  descriptor/digest faults, absent Source evidence, deleted batch/event, missing
  observation heads and malformed owner mappings. Find existing fault/native
  coverage preserving their outcomes; a valid backup cannot preserve an
  invented same-cut hole. Representative roots: `content-projection.integration.test.ts`,
  `outbox.integration.test.ts`, `private-original-source.test.ts`,
  `source-authenticated-api.test.ts`, `sys-receipt-relay-gap.test.ts`.
- Privacy/ownership capabilities: Agent/Collection/Context/Concept/presentation
  protection or visibility and Space stewardship races. Establish an existing
  owner transition or propose separately owned product work with reason.
  Preserve hidden/absent equality, stale read/admission and authority checks.
  Creating private initially is not evidence of mid-read ownership transfer.
  Representative roots: `search-card-fields.test.ts`, `typeahead-cards.test.ts`,
  `zone-route-keyed.test.ts`, `content-zone-revision-delivery.test.ts`.
- Native controlled validation/proof and synthetic joined-query inputs:
  keep the exact unsupported/unknown/partial/canonical/profile/rollback
  falsifiers in their correct owner/native layer. Existing
  `infra/jena/command-module/src/test/java/com/rezics/jena/MembershipSeekTest.java`
  is concrete membership denial/preparation evidence from G-1637. Read existing
  native validation tests before naming any new test; if missing, propose
  capability-named `CommandValidationFixtureTest.java` or
  `TextIndexSentinelTest.java`, not a new product fixture endpoint. Migrating
  coverage requires acceptance-owner approval of equivalence; deleting the
  integration assertion is not a fixture migration.

No X implementation session is ready merely because “restore” is named. A
pre-erasure backup plus current erasure ledger may supply erasure reconciliation,
but its exact held-cut/owner evidence must be established. A legitimately pruned
outbox would supply a retention scenario only after the retention owner
supports that pruning. Source classification alone does not establish either.

## Claim dependencies and parallel execution

| Shared file/family | Derived raw roots reached | Scheduling consequence |
| --- | --- | --- |
| `tests/qa/integration/g-937-support.ts` | g-1003-address-navigation, g-937-creation/migration/scopes/zone, work-address-api | One I owner changes helper first; A address root batches follow. X legacy/scope roots still blocked independently. |
| `tests/qa/integration/g-571-screen-support.ts` | agent-profile, g-1034-realm-ranking, g-571-profile-screen, g-571-screen | One A screen batch owns helper; profile corruption and its ranking wrapper remain X. |
| `tests/qa/integration/discovery-rating-context-fixture.ts` | discovery-read-isolation, g-1001-work-cards, g-1011-optional-work-reads | Remove optional root's import/call locally; don't rewrite shared global Context helper in parallel with card/combined-root owners. |
| `tests/qa/integration/discovery-projection-fixture.ts` | discovery-projection, discovery-rating-effects, discovery-read-isolation | One X owner handles graph/reset lifecycle; composite root last. |
| `tests/qa/fixtures/reference-disclosure.ts` | search-grouped-native | Exclusive X helper claim; inspect all nonintegration importers before changing evidence. |
| `tests/qa/fixtures/source-support-attachment.ts` | source-authenticated-api | Exclusive X helper claim; changing valid Source setup alone cannot remove corrupt-evidence probe. |
| `scripts/load/corpus-backup-driver.ts`, `work-profile-corpus.ts`, `catalogue-backup.ts` | New B recipes consume existing lifecycle | Read-only shared reuse permits independent recipe work. A required driver change gets one earlier owner; do not claim those files in every corpus batch. |
| `media-support.ts`, authored/author-credit fixtures, `support/**` | Multiple classes | Read-only reuse or one prerequisite owner. New per-capability helpers have separate exact claims; a wildcard support claim serializes otherwise independent work. |
| isolated registry and scan/ceiling tests | Every shrinking batch affects classification | One F owner handles shared expectations/isolation. Root workers need not edit the derived function. |

After F and helper prerequisites, A's organization/protection root batches,
C's poll/Statement/derivation batches, R's composition batches, O's cleanup
batch, E's independent erasure roots and B's **distinct** recipe files can
run in parallel without overlapping support claims. I's address helper and
A's screen helper each serialize their own dependents, not every class.
Actual QA slots, memory admission and each store's isolation remain the
existing orchestrator's decision; this is not a new scheduler.

Imported-test roots (`g-1034-realm-ranking`, `g-856-discovery/library/readers`,
`discovery-read-isolation`) qualify only after their canonical executed suites.
They do not require five extra corpus builders. Run the combined root after
dependencies to prove it has not retained another reachable raw site.

## Ten-hour window and remaining evidence

The table plans **28–40 Luna sessions** for F plus the 47 candidate roots,
including the four B recipe families. That estimate assumes small root-only
batches and successful conditional owner equivalence checks. M adds at least
one owner-evidence session; X adds four to six evidence sessions, with unknown
implementation count afterward. A planning assumption of 45–75 minutes per
session is **21–50 worker-hours** for candidates alone. At three independent
implementation lanes that is roughly **7–17 hours**, before shared prerequisites,
queued QA, regression and unresolved owner work. These are scheduling scenarios,
not measurements or a ten-hour promise.

A defensible first ten-hour tranche is F, small organization/protection batches,
the existing isolated search-cleanup batch, one real erasure batch, genuine
poll/derivation and small composition batches: cap at about 8–12 sessions and
report achieved roots and actual timings. Do not call the whole inventory
complete or predeclare CTX/IAM/LIVE/MODEL/PKG/SYS/RECIPE acceptance IDs green
from a scanner shrink alone. The missing run-9 failure JSON prevents that exact
failure-cluster-to-case accounting here.

Outside a credible ten-hour completion promise:

- The 102 M/X roots until retained provenance, capability or coverage ownership
  is settled. Fake receipts, dangling heads, same-cut source holes and online
  arbitrary model mutation have no demonstrated allowed builder.
- 40k genuine relation occurrences, multi-cut 10k chapter navigation and large
  cross-owner library backups until measured command throughput/build/restore
  fits the **600-second full preparation** limit. A valid restored backup may
  make subsequent runs cheap, but building the first source is also bounded.
  Do not omit startup, migration, readiness, smoke or stopped backup from it.
- Full native recovery/index activation qualification, any new product privacy
  or stewardship capability, and manager regression outside individual claims.
  `activateRebuiltPublicContentSearch` requires actual offline index evidence;
  isolated cleanup removal does not qualify full rebuild activation.

To complete the missing empirical baseline, provide the run-9 cluster JSON and
successful JUnit/log history inside this worktree, inspect with
`recordedFileDurations` and retain source/run IDs, distinguishing diagnostic
failure timings from green baselines. Do not rerun suites merely to populate
this analysis. The present per-file E30 estimates remain visibly qualified.

## Inspection result

Read-only scan/report comparison found **149 rows, 149 derived roots, zero
missing, extra or duplicate paths**. Helper-reachability inventory was inspected
from the same scan. No suite, typecheck, lint, docs check, dev server, storage
build/restore or product/test edit was run. Only this specification was written.
The runtime inspection used an ephemeral Task definition on stdin with the
worktree as its directory; it created no task file. Goal-slot inspection used
only permitted orchestration bookkeeping. Nothing was linked from state.md.
