# Actionable collections and ingredient reconciliation

This design defines ownership and semantics; it installs no capability.
API contracts and the six pending `recipes/cook-and-shop` outcome cells follow
after wave/2 merges. Implementation requires a later brief.

The competitor coverage report (2026-10-15, baseline `57b03b2435`), B04 and its
closing decision, identifies the missing job: turn captured recipes into a
shared list, see what to buy, then check off purchases and cooking steps.
Capture alone does not complete that loop. The report keeps recipe-manager
acquisition closed until the loop works; this decision does not change that cut.

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
entry, an ingredient or its sources. Map qualifier meaning to existing
vocabulary first; add a local term only for a documented semantic gap and its
schema. Existing profiles are not silently tightened.

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

Use [schema:Action](https://schema.org/Action) for the run and for each
run-scoped entry action. The run's `schema:object` is its pinned Collection
entry-set revision; each entry action's object is the entry occurrence. Map the
entry's `pending` and `checked` API values through
[schema:actionStatus](https://schema.org/actionStatus) to
[schema:PotentialActionStatus](https://schema.org/PotentialActionStatus) and
[schema:CompletedActionStatus](https://schema.org/CompletedActionStatus),
respectively. A check records the participant's completion of that entry in
that run, not completion of the underlying recipe or another run. These terms
describe the execution and its disposition, so no local Run class or duplicate
Pending/Checked status vocabulary is needed.

The one additional relationship proposed here is `rv:inRun`, from an entry
action to exactly one run action. Action's object and status do not express
which shared execution scopes an entry action; the same occurrence can be
acted on in several runs. This relationship preserves that distinction and
the `(run, entry occurrence)` uniqueness constraint. Exact source/binding pins
and compare-and-set item versions also require owner contract fields: Action
does not define their revision or concurrency semantics. Each future RDF
property for those fields must first be checked against existing vocabulary
and justified in its owning schema. [prov:Activity](https://www.w3.org/TR/prov-o/#Activity)
can describe a performed derivation and its provenance, but does not itself
supply the pending/completed disposition needed by the checklist. These are
semantic mappings, not grants; Access still authorizes every operation.

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
3. Within an ingredient group, convert registered units in the same dimension
   when the unit registry defines an exact rational factor. Metric prefixes
   such as g/kg and ml/l qualify; tsp/tbsp and other equivalences qualify only
   when defined exactly by the registry. Express each compatible subtotal in
   one declared unit of its group and retain every source's lexical quantity,
   original unit and conversion factor. Raw unit text or a matching namespace
   is insufficient. Density, count-to-mass and food-equivalence conversions
   are excluded. Locale-ambiguous units such as an unqualified “cup” stay
   separate, as do incompatible dimensions and units without an admitted exact
   factor. A range or missing amount, including “to taste”, is an unresolved
   entry with its reason and source; it is neither zero nor one of the numeric
   subtotal's contributors.
4. Convert eligible stock to the group's declared unit under the same exact
   rules, then apply explicitly supplied stock once per ingredient-and-unit group:
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

[UCUM 2.2](https://ucum.org/ucum), dated 2024-06-17, distinguishes unit equality
from commensurability and magnitude (§§18–20). That distinction supports the
same-dimension check; the procedure requires an exact rational
factor from the unit registry. UCUM does not supply food equivalence, egg sizes,
package quantities or flour density. Registry conversion definitions and their
version form part of the pinned procedure input; display rounding and its
conversion conventions cannot establish those definitions.

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
| The selected recipes require 1 kg and 200 g of the same flour; the declared subtotal unit is kg. | Required 6/5 kg (1.2 kg), retaining both lexical quantities and exact conversion factors. |
| The same flour occurs as 1 unqualified cup and 100 g. | Two separate lines; no density or locale assumption bridges the units. |
| Salt is “to taste”; another flour occurrence is measured in cups. | Salt remains unresolved; flour cups remain separate from flour grams. |
| Owner and granted shopper check the same egg entry concurrently, lose answers and retry. | One checked state; replay adds no effect. A stale opposite-status update conflicts. Recipe revisions and contents remain unchanged. |

Each persona needs its own public-API test on a real stack, without owner
mocks. The decided authority matrix for that fixture is:

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
