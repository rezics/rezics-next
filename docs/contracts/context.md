# Shared Contexts, interpretation and preferences

Status: adopted design, 2026-09-26. Shared semantic Contexts and their selection
contracts are target behavior; the installed Realm-bound classification profile
remains the limited implementation described under [transition](#installed-profiles-and-transition).

## Identity and responsibility

A Context is an independently identified Resource containing a sparse, versioned
set of interpretations, applicability assumptions and preferences. Individuals
and Realms use the same Context model. Several individuals or Realms can adopt
the same published revision; a Context needs no owning Realm or mandatory Agent.
Creation admits its actual owner, visibility and management authority through the
existing resource and Access contracts. All exposed Context summaries use the
shared name and avatar contract.

Keep these responsibilities separate within that model:

| Component | Meaning |
| --- | --- |
| Interpretation | Which exact meaning, definition or application criterion is intended for an object, term or relation? |
| Applicability | Which release, ending, period, canon or other declared conditions apply? |
| Preference | Which eligible objects, properties, languages or presentations should be selected, emphasized, ranked or recommended? |

Semantic and preference components have independent revisions. Changing a sort
order, language preference or display group does not create a new statement
meaning. A person's concrete classification or reading of an object is a
[Statement](classification.md), with attribution, evidence and the interpretation
actually used. Contexts supply reusable explanations and choices; they do not
materialize every possible object classification or replace individual judgments.

A selection pins its semantic revision and, when Context preferences are used,
the applicable preference revision separately. Preference changes preserve the
semantic pin. Resolve each preference from an explicit request, then the reader's
saved choice, the disclosed entry/Realm preference default, and finally the
admitted product default. These defaults choose among eligible values; they do
not bypass exact requests, content admission or the language owner's rules.

Individuals can use a shared Context unchanged, specialize it or create an
independent one. Personal specialization is optional and does not imply Realm
membership, a stricter definition or a mandatory private copy. Store actual
overrides sparsely. Realm membership, popularity and adopting a Context confer
no authority over its definitions or the referenced objects.

## Global and default Context

The **Global interpretation Context** is the public baseline used when no more
specific interpretation is selected. It has a stable resource identity, published
semantic revisions and no inherited parent. Its maintained definitions include
domain and applicability where needed. Specialized mathematical or other niche
concepts can have their complete professional definitions in this baseline;
audience size does not make a concept Realm-owned. Simple and technical
explanations can describe the same meaning.

Global describes a shared reference point, not universal agreement or a claim
that every expression has one meaning. Preserve established distinct referents,
alternative interpretations and unresolved ambiguity. A word, target type,
relation or surrounding domain may already provide sufficient disambiguation.
When it does not, return qualified candidates or an ambiguity outcome rather
than guessing from popularity or a private preference. A public alternative
Context is not automatically an adopted Global definition.

**Default Context** is a selection role, not another mandatory resource type.
It identifies the Context used by a particular speaker, entry point or operation
when no explicit selection applies. The general entry defaults to Global; a
Realm or individual may select another default and object/domain-specific
exceptions. Omitted Context therefore means resolve the declared default, not
erase interpretation. An explicit Global request bypasses local interpretive
defaults but never disclosure or publication authority.

Global interpretation and Global acceptance are separate roles. A public
definition does not accept every statement using it, and a baseline definition
cannot be revised through an acceptance vote. Language preference and UI locale
remain independent under [content languages](content-languages.md).

## Interpretations, concepts and preferences

Creating a named concept and selecting a contextual interpretation are independent
operations. A shared object remains a common reference while its scoped
interpretations have exact, independently referable definition components.
Use the existing DefinitionRef and revision machinery for such components; do not
reintroduce a mandatory Tag/Path/Expression/Sense identity chain.

| Difference or intent | Required representation |
| --- | --- |
| Different words for the same exact meaning | Attributed names/usage bindings and an explicit mapping where needed; matching labels alone prove nothing. |
| A word denotes genuinely different referents, such as a court institution and a narrative genre | Distinct concept Resources; Context selects the intended reference. |
| Additional examples or explanation preserve the intended criterion | Scoped documentation on the same meaning, with provenance. |
| A person or community changes a concept's application criterion | A precise contextual definition/criterion reference; it may coexist with the Global definition under the common object reference. |
| A meaning needs its own reusable object for selection, discussion, links or discovery | Create or reuse a named concept, referencing its exact definition. This does not disable contextual interpretations of either concept. |
| People use the same criterion but disagree about a case or its evidence | Independent statements, assessments or acceptance decisions under that criterion; no compulsory new concept or Context. |
| People agree on meaning but favor different results or aspects | Preference, filter or ranking configuration; no rewritten definition. |

A contextual override changes the selected interpretation in its declared scope;
it does not mutate the common object's Global definition or an earlier claim.
Different selected criteria are different qualified meanings even if their common
object and display label match. There is no automatic algorithm that decides
whether a distinction deserves a new named concept. Independence of reference and
actual reuse guide that editorial choice; semantic precision is required in
either representation.

Definitions may be human-readable. Automatic classification requires a separately
admitted executable pattern/rule with explicit inputs and missing-state behavior.
Prose, examples, a Context name or a majority vote cannot supply executable
entailment. Preserve uncertain evidence and unresolved boundary judgments.

### Harem example

These criteria illustrate the contract; they do not establish a universal genre
taxonomy. The public concept `後宮` as a narrative genre already has a domain
definition. It needs no enthusiast Realm merely to refer to works.

| Speaker/use | Selected interpretation |
| --- | --- |
| General use of `後宮` | The exact public genre definition. |
| Realm A's own use of `後宮` | A Context requiring several explicitly established romantic relationships in the applicable ending. |
| A member's personal use of `後宮` | Another Context requiring marriage, or another explicitly stated criterion. |
| Use of the separately named concept `真後宮` | That use's selected exact definition; the name itself does not settle open-ending, cohabitation or marriage disputes. |

The existence of `真後宮` does not prevent Realm A or its members from interpreting
`後宮` locally. Nor must their interpretation equal any definition of `真後宮`.
Where two uses truly share a criterion, they may reference the same definition
and an admitted mapping; do not keep duplicate authoritative rule bodies.
Creating a named concept never forces people to rename an existing local usage.
Changes to the criterion, disagreement about whether an ending meets it, and a
preference for that ending remain separate operations.

## Selection and statement meaning

A Realm can adopt a Context for its own statements about a particular object,
relation or admitted domain, and retain Global for other objects. A member can
use a different Context for personal statements in that Realm. The realm in
which a statement appears is not necessarily its speaker or semantic authority.
Speaking on behalf of the Realm requires the appropriate Access admission.

Resolve each interpretation slot using the following declared selection order:

1. An explicit exact interpretation/Context selection for this statement or query.
2. The selected speaker's admitted object-and-relation, object, domain, then
   default selection, using the operation's versioned scope profile.
3. The entry point's disclosed default, where the speaker has no selection.
4. The published Global baseline revision selected for this operation.

Resolve overlapping equal-priority selectors as an explicit conflict; never use
insertion order or silently union incompatible meanings. The target profile
admits one pinned base semantic revision per Context, with sparse entry overrides
and a bounded, cycle-free inheritance chain. A genuinely absent entry may inherit;
an explicit unresolved/disabled entry or an unreadable selected dependency is not
absence. It yields the declared ambiguity, unsupported or unavailable outcome.
There is no implicit subscription to future parent meanings.

The API returns the actual selected Context/component revisions, DefinitionRefs,
applicability and readable selection basis. A preview exposes that result; the
write binds it through expected revisions so a changed default cannot retarget
prepared intent. Preference resolution is separate and cannot change the meaning
of an already explicit statement or filter. A fixed-Realm surface may constrain
publication or query admission, but cannot silently translate a member's claim
into the Realm's chosen meaning.

Persist who speaks, the exact target/relation/value, the applied definition and
meaning-bearing qualifiers, and the Context revision through which they were
selected. These support both personal and institutional readings of any admitted
object, not only lexical labels. General sentence indexing is outside this scope.
Reading, quoting, translating, mounting or accepting an existing statement retains
its authored meaning. A viewer's different reading is a distinct attributed
statement or explicitly labeled projection.

Meaning equality uses the applied definitions and semantic qualifiers under an
admitted mapping, not the Context ID, speaker, preference revision or spelling
alone. Two Contexts may resolve the same meaning without merging their decisions,
sources or voters. Two uses of one object in one Context may differ by release or
ending. [Aggregation](search.md#statement-aggregation) retains these distinctions.

## Shared adoption, Access and revision

| Operation | Authority and effect |
| --- | --- |
| Read/use a Context | Check its visibility and exact dependencies. Public eligible use needs no membership in its creator's Realm and grants no edit authority. |
| Set/clear a personal selection | Current principal's private preference authority; changes only that selection. |
| Set/clear a Realm selection | Current authority for that Realm and scope; does not grant Context editing or speak for every member. |
| Propose/edit/publish a Context | Explicit rights on that Context and operation; referenced concepts retain their own owners. |
| Manage Context grants | Existing Access assignment ceilings, representation and lifecycle checks. |

Use existing Access resource scopes, grants and private principals. A Context is
not automatically an authority subject merely because it is a Resource. Editing
its public description cannot grant control. Public authorship and the private
principal performing a mutation remain separate.

Commands use expected component/selection heads, idempotency, immutable revision
manifests, owner receipts and outbox events. Concurrent edits to the same head
conflict; semantic disagreement can produce a proposed alternative or derived
Context with provenance. Access determines who may change each resource, not
which interpretation is universally correct.

Consumers select published semantic revisions. A maintainer's new revision does
not silently advance Realm/personal selections or existing Statements. Adoption
of a successor is its own guarded selection transition. Preference-only revisions
do not change semantic keys. Retiring a Context stops new adoption under policy;
retained exact references preserve their meaning and apply current disclosure.
Missing or withheld historical state returns unavailable, never a newer meaning.

Private personal selection pointers remain Access-owned convenience state;
Context definitions and public Realm adoption links belong to the semantic owner.
Both public and private Context resources follow their actual disclosure policy.
Do not publish private principal-to-Context links or infer them from shared use.
A public statement must make its required semantic basis readable to its admitted
audience, or report incomplete/unavailable interpretation; it cannot fall back to
a different public definition to hide a private dependency. A reviewed publishable
definition may preserve the intended meaning without exposing private preferences.

## Typed context roles

| Role | Question |
| --- | --- |
| Interpretation | Which definition, usage and applicability are intended? |
| Preference | Which eligible choices or aspects should be emphasized? |
| Governance | Which authority can decide/adopt this state? |
| Semantic acceptance perspective | Which Global/Realm/personal decision scope accepts this exact qualified statement? |
| Rating context | What question, target grain, eligible population, scale and cadence are evaluated? |
| Publication selection | Which Main Version/contribution/revision is served? |
| Semantic canon | In which fictional world, continuity or evidential setting does a claim hold? |
| Presentation | Which Zone/site/navigation frames the response? |

Shared interpretation Contexts do not merge acceptance scopes, rating populations,
publication selections or Access rights. These roles have distinct references
even where one preset chooses several together. A JSON-LD `@context` is an exchange
term mapping, not one of these product selection or authority mechanisms.

## Effective statements and classification

One qualified fact can have independent acceptance decisions over its supporting
Statements. Select the interpretation first, then resolve acceptance of that exact
meaning in the requested decision scope. A local interpretation of `後宮` cannot
inherit Global acceptance of a different interpretation merely because labels or
the common concept ID match. Any reuse requires the admitted definition mapping
and decision policy, with its actual evidence retained.
A broader accepted claim cannot satisfy a narrower criterion without evidence
for the added conditions. Mapping direction and applicability remain explicit.

| Local state | Inherit policy | Isolate policy |
| --- | --- | --- |
| Accepted | Use local decision and evidence. | Use local decision and evidence. |
| Rejected/suppressed | Suppress the claim; never fall back. | Suppress the claim. |
| No local decision | Use eligible Global decision for the same meaning, labeled inherited. | Unknown/no selection. |
| Unreadable/unavailable local state | Return an admitted unavailable outcome; do not infer absence. | Same. |

Interpretation inheritance and acceptance fallback are separate versioned policies.
Neither merges vote identities or populations. Missing data and negative evidence
remain distinct. Queries and cursors bind the actual semantic selection, decision
policy, data generation and disclosure domain.

## RDF and named graphs

Use identified definitions, statements, decisions and typed links. Named graphs
may delimit acquisition, lifecycle, exchange or query datasets; they are not
automatically truth, access, Realm or transaction scopes. One Context or Realm
requires no separate graph/dataset. Graph membership cannot prove authority.

Scope local definitions and term bindings explicitly. Do not publish incompatible
local meanings as unqualified global `skos:definition`/`skos:prefLabel` assertions
or treat `skos:inScheme` as scoping every predicate. A qualified Statement must not
be exported as an unconditional base triple that changes its meaning. Use the
selected [model profiles](model-profiles.md) and retain exchange residuals.
Contexts cannot change the semantics of standard RDF/OWL terms, native owner
contracts or authority-bearing predicates. A different application criterion is
an explicitly qualified definition/claim under the admitted profile, not an
override of the underlying representation or validation language.

Do not union conflicting Context rules before reasoning: first select compatible
definitions, eligible facts and admitted rules. Derived results retain their
input definitions, applicability and rule revisions. Broader/narrower labels or
navigation alone cannot establish logical inclusion between two criteria.

## Ratings and selection

One Realm can define several [rating contexts](ratings.md). Sharing an
interpretation Context does not share their questions, voters or results.
Targeting a Work/Main Version, translation or release answers different questions.
Show inherited/global series separately with their populations and uncertainty.

An exact requested publication/revision resolves under current disclosure or
returns unavailable. Ordinary content requests use [Main Version selection](main-version.md)
and independent [language preferences](content-languages.md). Zone placement,
semantic interpretation and a personal preference cannot publish drafts or
override substantive content admission.

## Operations and bounded resolution

Define the Context owner schema, component DefinitionRefs and selection scope
profile before implementation. Create/revise/publish/derive/retire, select/clear,
resolve and compare are owning operations under the guards above. Definition
extraction into a named concept references reviewed exact meaning and preserves
old statements; it neither copies an uncontrolled rule body nor deletes local use.

Resolve indexed speaker/scope selections and only the bounded pinned dependencies
actually required. Batch definition/name/avatar hydration within the caller's
budget. Declare limits on scope candidates, inheritance depth, entries, bytes and
rule work; reject overflow or return an explicit partial result as the operation
allows. An incomplete semantic resolution cannot authorize a write or exact count.
Do not scan every Realm/member or materialize Resource x Context x principal.
Context edits stage bounded dependency invalidation; selected semantic versions,
acceptance, preferences and disclosure invalidate their respective projections.
Final capacity claims require the [statement workload](../storage/workloads/statement-capacity.md).

## Installed profiles and transition

The earlier `classification-context-v1` profile has a fixed Global
ClassificationContext and a distinct Context bound to one active Realm under
`classification-inherit-global-v1`. Its reciprocal Realm link identifies the
classification role; the Realm ID retains governance/publication identity.
The guarded provisioning, direct decision and public resolver are installed.
Local rejection suppresses Global acceptance; confirmed local absence inherits;
incomplete or moving selected state returns unavailable. The unchanged
`space-realm-v1` command retains its original publication role.

That Application/Sense implementation does not implement reusable semantic
Contexts, personal/object-scoped interpretation selections or separate preference
components. Its fixed Realm binding is not the target Context identity rule.
Schema-first replacement follows the [statement transition](classification.md#installed-profiles-and-transition).
Map retained v1 meaning, decision scope and receipts explicitly; do not relabel
an old acceptance Context as a new interpretation Context or infer definitions
from its Realm name. Shared Context runtime acceptance remains pending.

## Acceptance

The retained [CTX cases](../testing/classification.md) cover shared/private
Contexts, Global/default distinction, Realm/member speech, simultaneous local
interpretation and named concepts, criterion/evidence disagreement, Access,
revision pinning, scoped aggregation and bounded resolution. Historical v1 passes
do not qualify these additions. This documentation decision runs no runtime work.

## Evidence and limits

Reviewed 2026-09-26: [SKOS concepts and labels](https://www.w3.org/TR/skos-primer/#secconcept)
separate conceptual resources from their words; [documentation properties](https://www.w3.org/TR/skos-reference/#notes)
support definitions, examples and scope notes. The
[OntoLex community report](https://www.w3.org/2016/05/ontolex/) distinguishes lexical
entries, referenced meanings and usage conditions; it is not a W3C Recommendation.
These sources support precise lexical/semantic references but do not prescribe
REZICS's Global/default policy, shared Context lifecycle or concept-creation rule.
Their optional lexical modeling does not mandate a Sense record for every object.
[RDF datasets](https://www.w3.org/TR/rdf11-concepts/#section-dataset) also do not
supply Realm governance or assertion acceptance. The composition here is a REZICS
design whose owner APIs, recovery, aggregation and workloads still need validation.
