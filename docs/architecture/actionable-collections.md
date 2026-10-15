# Actionable collections and ingredient reconciliation

Status: proposed for program review, 2026-10-15. This note decides ownership
and semantics; it installs no capability. API contracts and the six pending
`recipes/cook-and-shop` outcome cells follow after wave/2 merges. Implementation
requires a later brief and review of this decision.

The competitor coverage report (2026-10-15, baseline `57b03b2435`), B04 and its
closing decision, identifies the missing job: turn captured recipes into a
shared list, see what to buy, then check off purchases and cooking steps.
Capture alone does not complete that loop. The report keeps recipe-manager
acquisition closed until the loop works; this proposal does not change that cut.

## Evidence and existing owners

[Paprika 3's Android guide](https://www.paprikaapp.com/help/android/) describes
combining two recipes' egg quantities, retaining recipe associations, pantry
selection and purchase checkoffs. [Mela's grocery help](https://mela.recipes/help/)
describes using a Reminders list that can be shared with household members.
Reviewed 2026-10-15, these are vendor descriptions of offered behavior, not
evidence of demand or a measured REZICS user outcome. Our deduction is that
shared actionable entries and optional arithmetic are the smallest reusable
boundary; neither vendor's storage layout is a requirement.

| Owner inspected | Reuse | Missing meaning |
| --- | --- | --- |
| [Collection profile](../../model/definitions/collection-curation-v1.ttl), [registration](../../services/main/src/modules/collection/structure-profile.ts) and [routes](../../services/main/src/routes/collections.ts) | Collection identity, curator, disclosure, ordered Structure occurrences, immutable revisions, guarded changes and receipts. Two occurrences of the same target remain distinct. | An actionable entry can refer to an exact source occurrence or several contributing occurrences; a shared execution has its own state. Existing members remain resource references. |
| [Visible collection pages](../../services/main/src/modules/collection/visible-page.ts) and [target resolver](../../services/main/src/modules/target/resolve.ts) | Filter unreadable targets before disclosure and continuation; resource readability remains an owner decision. | Derived quantities and provenance need the same disclosure protection, including after access changes. |
| [Dynamic collections](../../services/main/src/modules/collection/dynamic.ts) | Versioned, admitted selection definitions and explicit capture coverage. | Current phrase-search definitions neither execute a collection's members nor reconcile quantities. A declared binding must name the actual procedure and revision. |
| [Recipe profile](../../model/definitions/recipe-structure-v1.ttl), [qualifiers](../../services/main/src/routes/recipe-qualifiers.ts) and [Structure format](../../services/main/src/modules/structure/format.ts) | Ingredient/step occurrence identity, exact revision, original text, amount/range, unit, parse/scaling status, preparation and step-to-ingredient links. | A run references this structure; it never puts checkoff state into recipe qualifiers. |
| [Quantity](../../services/main/src/modules/recipe/quantity.ts), [operations](../../services/main/src/modules/recipe/operations.ts) and [display](../../services/main/src/modules/recipe/display.ts) | Reduced bounded non-negative rationals, exact scaling and unit registry identities. Nutrient sums illustrate grouping by identity and unit. | Ingredient sum and stock offset have different provenance and missingness from nutrition. Rounded kitchen display and its conversion conventions cannot decide arithmetic compatibility. |
| [Progress store](../../services/main/src/modules/progress/store.ts) and [routes](../../services/main/src/routes/progress.ts) | Patterns for occurrence keys, per-item versions, compare-and-set and replay. | Existing progress is private to the reader principal. It cannot become household state by impersonating its owner or changing all reader progress to shared state. |

## Decision: entries, then independent runs

Extend the Collection owner with an optional actionable-entry qualifier. Each
entry retains a Structure occurrence identity and order. Existing resource
members keep their current meaning. An entry may additionally anchor an exact
source occurrence, or record several sources for a derived line. The extension
must admit entries without a single resource target: a combined purchase line
can have contributions from multiple recipes. Labels alone never identify an
entry, an ingredient or its sources. New qualifier meaning gets its own term
and schema; existing profiles are not silently tightened.

An exact source reference carries the source Collection member occurrence
(when selected through a plan), source resource, Structure, revision and
ingredient or step occurrence. Repeating one recipe as two plan entries is
intentional multiplicity. Repeating the same source reference within one
selection is an invalid duplicate, not extra demand. Two distinct flour
occurrences remain distinct even if their names match. A step that references
one ingredient occurrence does not add that ingredient a second time.

A run is a separately identified execution owned by Collection. It pins one
entry-set revision and, where applicable, source revisions, binding revision,
quantity factors and stock input. State is keyed by `(run, entry occurrence)`
with `pending` or `checked` and an item version. A new run starts pending.
Moving an entry does not change its identity; a changed plan or reconciliation
creates a new entry-set revision and an explicitly new run. It does not silently
move checkoffs onto a different purchase requirement. Historical source pins
retain meaning but confer no continuing right to read erased or hidden data.

Checking sets an explicit desired status; it is never a toggle. Two shoppers
checking the same pending item converge on checked. A same-status write can
succeed without incrementing its version again; an opposite-status write must
match the current item version or return a conflict with the current readable
state. A retry with the same key replays the committed receipt without applying
the command again, even after later edits; a fresh read supplies current state.
Reusing a key with different input conflicts. Authority is checked again before
replay disclosure. Writes to different entries do not contend on one run-wide
version. Reuse admitted-command and receipt machinery where it fits; the
private progress table remains private.

Purchasing an aggregate entry checks only that purchase entry in its shopping
run. Cooking uses entries anchored to ingredient or step occurrences in a
separate run. Neither action edits a recipe, asserts that another cooking step
is complete, updates reading progress, nor consumes pantry stock.

## Optional declared binding

A plain collection/run needs no binding and no quantities. An optional binding
declares a registered action or query identifier, its version, exact selection
scope and validated parameters. Collection owns the association; the named
capability owns execution and its authorization. Saving a binding does not run
it or grant permission. Omitted binding in an ordinary edit preserves it;
explicit null removes it. Unknown procedures fail validation. There is no
arbitrary code, external URL invocation or implicit action on checkoff.

Existing dynamic selection definitions remain authoritative for saved queries;
reuse their version/capture semantics rather than introducing a second saved
query engine. A future selected-community feed can bind a Collection's member
set to the feed owner. It still needs its own admitted operation and outcome;
following every member is not equivalent. This recipe step does not implement
feeds, schedules, timers, reminders or external Calendar/Reminders adapters.

## Named procedure: ingredient-sum-stock-offset-v1

Add this procedure to the existing Recipe quantity/operations owner. It reads
authorized, pinned ingredient occurrences and returns a reviewable derivation
that can be captured as Collection entries. Collection owns those entries and
their run; Recipe owns arithmetic and provenance. There is no shopping service
or independent pantry inventory ledger in this decision.

The procedure applies these rules:

1. Resolve the complete declared selection and retain every source reference,
   original lexical quantity and step association. Apply only admitted exact
   scaling; unresolved, non-linear or judgment-dependent quantities stay
   unresolved rather than receiving an invented factor.
2. Group ingredients only by a shared admitted ingredient identity or an
   explicit caller-confirmed equivalence group over the selected occurrences.
   Where neither exists, keep separate entries and expose the needed decision.
   Names, translations, substring matches and preparation text do not prove
   interchangeability. Optional ingredients and substitution alternatives need
   an explicit inclusion choice; do not silently add every alternative.
3. Add exact amounts only within an ingredient group and an admitted identical
   unit. Registered aliases may resolve to that identity; raw unit text or a
   matching namespace is insufficient. The first procedure version does not
   convert different units, even dimensionally compatible ones. Mass, volume,
   count and unknown measures remain separate. A range or missing amount,
   including “to taste”, is an unresolved entry with its reason and source;
   it is neither zero nor one of the numeric subtotal's contributors.
4. Apply explicitly supplied stock once per ingredient-and-unit group:
   `used = min(required, stock)` and `toBuy = required - used`. Return required,
   stock used, remaining demand and unused stock as exact rationals. Retain a
   zero-demand entry with its provenance. Missing stock means no offset was
   declared, not a claim that the household has none. Incompatible or ambiguous
   stock is reported unapplied; it cannot reduce another unit's subtotal.
5. Preserve all contributing occurrences beneath each subtotal and all
   unresolved lines beside it. Reuse the exact quantity bound; overflow or an
   invalid rational refuses the derivation without publishing a partial list.
   A private stock input can only be shared with the owner's explicit authority
   to disclose that input and its derived demand.

The conservative unit rule is a deliberate first-version choice.
[UCUM 2.2](https://ucum.org/ucum), dated 2024-06-17, distinguishes unit equality
from commensurability and magnitude (§§18–20). That distinction supports keeping
unit identity separate from conversion. It does not supply food equivalence,
egg sizes, package quantities or flour density. A later conversion policy would
need a named, versioned rule and its own counterexamples; display rounding is
not such evidence.

## Authority, disclosure and bounded work

Access remains the only grant owner. Collection editing, run reading, checking
and run administration are separate actions/scopes to be declared in the
resumed contract step. A curator can administer the run and grant a shopper
read/check access without granting recipe edits or Collection restructuring.
Realm membership alone grants nothing on a private household run. Revocation
applies to subsequent reads, writes, continuation and replay.

Reading a public plan or recipe does not reveal a private run, check history or
stock. A participant also needs current source readability. For this first
version, if any pinned contribution becomes unreadable, the derived result is
unavailable to that caller as a whole: no stale totals, labels, counts or
provenance from inaccessible inputs. Do not return a misleading reduced total
under the same derivation identity. Source erasure likewise prevents replay of
copied recipe text. Hidden run identities return a concealed unavailable
answer; a readable run with insufficient write authority returns a denied
answer. Moderator/operator status does not imply private-run access or editing.

Traversal follows the existing ordered, disclosure-filtered continuation
pattern, including separate continuation for large provenance lists. A request
budget is not a total collection limit. Capture must either finish the declared
selection with complete coverage or return an explicit capacity/unavailable
outcome with no completed run. It must not label a prefix a complete shopping
list. Exact limits, continuation binding and any staging protocol belong in
the executable owner contracts before implementation; no latency or capacity
claim is established by this note.

## Alternatives and proof required before implementation

Putting checks into recipe qualifiers would modify shared publication while a
cook acts on one occasion. Reusing private reader progress as shared state
would cross its authority boundary. A shopping-specific backend would duplicate
entry identity, ordering, disclosure and receipts. Mandatory quantity fields
on every collection would burden reading plans, project checklists and
itineraries. The chosen split accepts a new Collection run concept and a
separate optional derivation so each of those existing meanings survives.

The resumed step must express requests/responses, errors, grants, pagination,
atomicity and replay in the Collection and Recipe owning contracts, then add
`recipes/cook-and-shop` with all six cells pending. The falsifying fixture is:

| API observation | Expected outcome |
| --- | --- |
| Two selected recipes require 2 and 3 eggs in the same admitted count unit; stock input is 1 egg. | Required 5, stock used 1, to buy 4; both source occurrences remain visible. |
| One recipe uses 100 g flour in one step and 50 g in another. | Shopping subtotal 150 g retains both occurrences and their step links. Cooking checkoffs remain separate. |
| Salt is “to taste”; another flour occurrence is measured in cups. | Salt remains unresolved; flour cups remain separate from flour grams. |
| Owner and granted shopper check the same egg entry concurrently, lose answers and retry. | One checked state; replay adds no effect. A stale opposite-status update conflicts. Recipe revisions and contents remain unchanged. |

Each persona needs its own public-API test on a real stack, without owner
mocks. The proposed authority matrix for that fixture is:

| Persona | What the API should allow |
| --- | --- |
| Signed-out visitor | Read published recipes and the public plan; private run concealed; commands require authentication. |
| Signed-in stranger | Read the same public material; private run concealed; cannot check or impersonate the owner. |
| Member with an explicit shopper grant | Read the shared run and its disclosed derivation; check entries and retry; cannot change plan, stock basis, grants or recipes. |
| Author/owner | Create/capture the derivation, start a run, administer sharing and check entries; independently exercise their existing recipe-edit authority. |
| Realm moderator without a run grant | Public reads and ordinary moderation remain available; private run concealed and peer checks denied. |
| Platform operator without a run grant | Public reads and existing platform operations remain available; platform status adds no household access or peer check authority. |

The contract/outcome step must show the unsupported operation failures and
record unreached assertions honestly; a route's absence is not proof of
role enforcement. Then an independent implementation brief can make the cells
pass. UI proof follows those APIs; this note establishes neither a rendered
journey nor recipe-manager replacement parity.
