# Subject associations and contextual reading

The [relation occurrence schema](../../services/main/src/modules/relation/schema.ts)
preserves repeated occurrences and role-specific participants. The
[Statement schema](../../services/main/src/modules/statement/schema.ts) and
[read path](../../services/main/src/modules/statement/read.ts) retain exact
qualified meanings and disclosure checks. Neither owner currently provides a
complete contextual subject-association read profile.

## Remaining association contract

An appearance needs the related Resource, role, context and exact evidence,
independent of popularity voting. A source's protagonist role does not establish
a gender-qualified role without reviewed mapping. Combined filters must bind
traits to the same character and appearance under compatible release, canon and
time. Work projection counts distinct Works and retains the matching occurrence
and statement IDs; it does not assert a character trait on the Work.

Reads must apply current context and spoiler policy to labels, links, snippets
and counts without copying a target's NSFW label or changing the user's other
preferences. Re-anchoring after edits is explicit and may remain unresolved.
Qualify exact historical citations, conflicting contexts and private nodes in
bounded inverse reads before this page can be retired.

## Pending public query proposal

The following interface and matrices are **pending manager approval and proof**.
They specify the audit scenarios C03–C05, C07–C09, C15, C19 and C25. They do not
claim that a query, persona cell, source mapping or corpus has passed. The
manager-supplied audit decisions (staged as `.temp/ref/decisions.md` for this
worker) approve the outcomes; the interface choices below still need disposition before a separate
implementation author starts. Source-update/adoption proof remains with source
coverage; these rows test the resulting read and its exact independent supports.

### Interface decisions for disposition

| ID | Proposed choice and reason | Alternative considered |
| --- | --- | --- |
| SA1 | Add `https://rezics.com/query/subject-associations`, revision `1`, to the existing public `POST /v1/query` `template-query-v1` envelope. One generic capability reads appearances and credits forward and backward. | Extending the unfiltered relation GET alone cannot express correlated predicates or distinct Work projection. A domain-specific endpoint would duplicate the same meaning. |
| SA2 | Bind every role and trait predicate to one exact subject participation in one occurrence, under the selected Context and compatible frame. Return occurrence, participation, Statement and revision identities. | Independent existential joins over a Work admit the red-haired side character plus black-haired lead counterexample. |
| SA3 | Public/global is the default knowledge projection even for an owner. An explicit Realm Context admits only that Context's adopted, currently authorized facts. No draft-management mode is added here. | Treating an acting subject or staff role as publication would expose drafts and private evidence. |
| SA4 | The existing `/v1/works/{id}/credits` GET accepts an opt-in `profile=subject-associations-v1` and projects the same credit witnesses as SA1. Preserve its existing default revision-1 response; required new contextual fields are not retroactively imposed on it. | A second credit store or newly synthesized occurrences could disagree on identity and attribution. |
| SA5 | Reuse exact `wikiClaimEvidence` citations, native/external participant identity and source-position contracts. A participation's credited name, provider alias/eid and note stay attached to that participation, separate from the Resource's display name. | Names, local IDs without provider/namespace, and popularity cannot establish identity or evidence. |
| SA6 | Opaque, selection- and reader-bound keyset continuations traverse the whole disclosed result. Source/model/restore generation changes return `409 stale_query_result` with an explicit restart. Current authority is checked again on every page. | A scan limit, an empty page or a historical cursor must not freeze disclosure or masquerade as a complete result. |

The local [template envelope](../../services/main/src/modules/query/template-schema.ts),
[occurrence schema](../../services/main/src/modules/relation/schema.ts),
[frame reader](../../services/main/src/modules/projection/frame-read.ts),
[credit reader](../../services/main/src/modules/query/templates/work-credits.schema.ts)
and [evidence schema](../../services/main/src/modules/wiki/evidence-contract.ts)
are the inspected engineering precedents. This proposal extends their admission;
their existence does not prove the composition. No storage index, source-specific
mapping algorithm or new authority mechanism is prescribed.

### Request and result schema

The executable test types live in
[the context outcome support](../../tests/qa/support/context-outcomes.ts).
The proposed closed request is:

```ts
{
  profile: 'template-query-v1',
  query: 'https://rezics.com/query/subject-associations', revision: 1,
  parameters: {
    kind: 'appearance' | 'credit',
    direction: 'work-to-subject' | 'subject-to-work',
    roots?: Participant[],
    projection: 'work' | 'occurrence',
    context: 'global' | { realm: NativeId },
    frame: NativeId[], position: 'start' | 'all' | NativeId,
    match: { role?: RoleIri, all: Predicate[], any: Predicate[], none: Predicate[] },
    snapshot?: { sourcePosition: SourcePosition, modelGeneration: string }
  },
  presentation: { language: 'en', actingSubject?: NativeId },
  limit: number, cursor?: string
}
```

`Participant` is the occurrence owner's `{kind:'resource',ref}` or
`{kind:'external',provider,namespace,key}`, never an authenticated Agent inferred
from an external person. `Predicate` is `{predicate: DefinitionRevision,
value: SemanticValue}`. Root arrays, when supplied, contain 1–64 distinct exact
identities. Omission means all Works in the selected authorized catalogue and
is admitted only for `work-to-subject` with a nonempty role or predicate filter.
`[]` and `null` never mean all. Inverse roots are required. Explicit Work roots
must be native; external roots are admitted for inverse credit reads. This
template deliberately does not change other templates' native-root schemas.

`context`, `frame`, `position`, `projection`, `kind`, `direction` and the three
predicate arrays are required. Arrays of predicates contain at most 16 distinct
values each. Omitted `role` leaves role unfiltered; null and unknown fields are
invalid. An empty `all`/`none` is neutral; empty `any` means no additional
restriction. Nonempty `any` requires at least one match, `all` every match,
`none` no match **in the disclosed adopted projection**. `none` is not evidence
of a negative fact. Unknown/unadopted/uncertain/conflicting assertions cannot
satisfy a positive predicate. Unfiltered inspection retains their explicit
qualification when the underlying adopted association is readable.

Frame arrays contain 0–8 exact coordinates, normalized by the existing frame
owner. Incompatible duplicate dimensions, unrelated Work coordinates and an
unavailable reading position are refused, not silently broadened. Release,
canon/continuity and time coordinates must be jointly compatible across the
occurrence and every matching Statement. A global trait may apply only when its
declared coverage includes that occurrence. Repeated appearances are never
collapsed into an unconditional character or Work trait. Two contradictory
claims in different compatible frames stay qualified; an unresolved conflict
in the same selected frame cannot count as an asserted positive.

`limit` is 1–64 (default 20 when omitted); a cursor is opaque and at most 2,048
characters. The existing POST returns `{profile:'query-v1',template:
'https://rezics.com/query/subject-associations',selection,result}`. `selection`
echoes the complete normalized request selection, excluding the cursor, without
private identities. `result` uses `template-result-v1`, the query IRI and
revision, `sourcePosition`, `nextCursor`, `complete`, `items`, and the existing
`count:{value,kind:'exact-page',total:null}`. The count is the number of returned
items after disclosure, never an undisclosed population or a scan-window size.

An occurrence item is an `AssociationWitness`: kind, Work, exact occurrence and
revision, exact definition, Work and subject participation IDs, subject identity,
role, Context, applicability coordinates, qualification, complete participations,
matched exact Statements, citations, safe labels/snippets and executable links.
Statement witnesses retain exact ID, revision, subject, predicate, value, Context,
occurrence scope (null only for explicitly global coverage), applicability,
qualification, decision revision and citations. Citations preserve the source Work,
representation digest, locator, method, rights basis and evidence ID; source
snapshots and observations remain independently attributable. Withheld quotes
use the existing `quoteWithheld` contract. Citation volume is bounded at 16 per
claim; a larger admitted claim must provide a truthful continuation before it
can be represented as complete. No test permits silent citation truncation.

Occurrence order is `(work, occurrence, subjectParticipation)` in IRI lexical
order. Repeated identities across pages are invalid. `projection:'work'` orders
distinct Works by IRI and returns `{work,matches:{items,complete,nextCursor}}`.
Matches retain up to 64 witnesses; a further witness uses the same operation's
occurrence projection, restricted to that Work, with the supplied opaque cursor.
The Work count stays one when two occurrences match. Its match cursor is bound
to the occurrence projection with limit 64 and that Work, preserving the outer
filter and presentation, and cannot be used as an outer Work cursor. The tests
exercise both projections and a Work with more than 64 appearances.

`complete` is true exactly when that collection is exhausted and its cursor is
null. An empty bounded page may have a continuation; it is never an empty final
answer until the authorized frontier is exhausted. Limits bound each request,
not the catalogue size. The implementation must declare and qualify finite
candidate, hydration, call, byte and deadline budgets under the
[capacity policy](../storage/workload-budgets.md#fixed-bounds-for-interactive-requests).
Budget exhaustion without a resumable frontier returns `503`, never an exact
empty set. These tests establish semantic bounds, not a measured cost envelope.

All selected Context, frame, release, canon, time, role, predicates, roots,
projection, language, page size, effective reader/acting subject and disclosure
basis bind the cursor. A changed binding returns `400 invalid_cursor`; stale
source position, model generation or restore epoch returns `409
stale_query_result` with `restart:{method:'POST',path:'/v1/query',body}` retaining
the selection and omitting its cursor and optional obsolete snapshot pin.
`parameters.snapshot` explicitly pins both source position and model generation;
omission selects current. A snapshot never pins past authority or automatically
re-anchors a citation. Current revocation/restrictions may hide
more records on resumption; they never expose formerly hidden records. If a
consistent resumption cannot be established, return the same explicit restart.
Invalid shapes are `422`; missing authentication where required is `401`;
unavailable explicit roots/Contexts use the same `404` as nonexistent ones.
Missing and denied roots have identical problem bodies. No data-bearing `2xx`
or empty set substitutes for an unavailable service or rejected request.

For SA4 the GET accepts `profile`, `context` (`global` or a Realm IRI), repeated
`frame`, `position`, `language`, `actingSubject`, `limit` and `cursor`. It fixes
kind to credit, direction to forward, one Work root, occurrence projection and
empty predicate arrays. It returns the **result**, with the same identities,
order, citations and continuation semantics as POST. Continuations bind the
surface: a GET cursor cannot resume POST. A link declares method and, for POST,
the exact body; discovery/POST templates are not GET resource links.

### Disclosure and six-persona matrix

Every cell below is pending. Each row has six explicit `outcomeTest` registrations
in its prove file; each registration executes all that row's matrix cases.
The global catalogue is pinned to public adoption for every persona. No staff,
membership, ownership, arbitrary source assertion or vote expands it. Source
protagonist is gender-unqualified unless an independent reviewed Statement
establishes gender. Context and spoiler policy apply **before** matching,
deduplication, counts, hydration, snippets, links and citations. A private
co-participant withholds the whole witness; a public Work is not evidence for
its private counterpart. No NSFW classification is copied onto a target and no
read changes preferences. Explicit `position:'all'` changes only this read's
spoiler boundary, preserving age/region, rights and Access restrictions.

| Persona | Global appearance/trait query | Credits and inverse | Explicit private Realm Context |
| --- | --- | --- | --- |
| visitor | Anonymous public matches, exact safe evidence; no draft/private/spoiler oracle | Public native and external credit witnesses; anonymous graph POST still returns 401 | Same 404 as unknown Context |
| stranger | Same public set; own preferences do not expose foreign evidence | Public inverse identities only; cannot consume another reader's cursor | Same 404 as unknown Context |
| member | Same public set; membership does not adopt global claims | Same public inverse and no private co-participant | Adds only the explicitly admitted Realm witness |
| owner | Same public set even for owned drafts; management remains separate | Same public inverse; source persons remain external | Adds the admitted Realm witness under explicit Context |
| moderator | Same public set; moderation is not ordinary read authority | Same public inverse, attribution and masks | Same 404 as unknown Context without separate membership |
| operator | Same public set; platform mandate does not publish evidence | Same public inverse, no hidden IDs/counts/path | Same 404 as unknown Context without separate membership |

### Fixture matrix and proof selection

Both prove files use one reusable command-created corpus, with the same immutable
backup across baseline and later proof. The source manifest holds command
receipts, exact snapshots/observation IDs, rights bases, adopted/rejected/
unsupported/unknown dispositions and six real HTTP identities. Original fixture
stories and catalogue claims are labelled original; source-faithfulness cases
must use the frozen retained source bytes and reviewed mapping. Never fabricate
successful source data. `restorePersonaRealms` restores sign-in normally.
Fixture setup runs in `beforeAll`, outside `test.failing`, and requires a
restoration attestation for the current isolated QA run, not a shared dev URL.

| Fixture | Required positive/negative observation |
| --- | --- |
| redLead | One red-haired protagonist, two compatible occurrences with different exact evidence; one distinct Work, both witnesses |
| mixedPeople | Red-haired side character plus black-haired protagonist; never a red-haired protagonist match |
| mixedOccurrences | Same subject, red trait in a different incompatible appearance; no cross-occurrence join |
| otherRelease / otherCanon / otherTime | Same subject's red evidence belongs to an incompatible release/canon/time; negative in selected frame, positive in its own frame |
| uncertain / conflicting | Qualified trait evidence is retained on unfiltered inspection; no asserted-red positive in selected frame |
| sourceProtagonist / explicitMale | First has a source protagonist role and no gender Statement; only the independently supported second matches male |
| realmOnly / privateCoParticipant / spoiler | No global private/Realm leakage; whole private witness withheld; unrevealed names, snippets, citations, links and counts disappear at start and reveal only at an authorized explicit position |
| credits | All six currently supported native creator roles and the imported transcriber role, plus a performer-character-Work triple; repeat performer on another release/character; external aliases/eids/notes and provider-key collision; preserve exact occurrence and participant IDs |
| inverse | Character, native Person, external person, organization and term roots; 65 public adjacency witnesses; over 800 private candidates in known lexical order with a public witness beyond the existing 100 × 8 scan window |
| witnessOverflow | One Work with 65 appearances, so a distinct-Work result cannot hide its 65th matching witness |
| change/recovery | Restored before/after source-support, generation, revocation and restore cuts; one withdrawn support leaves its independent support and human decision intact; historical citations do not re-anchor silently |

The finite corpus's complete Work inventory contains at most 64 Works (many
occurrences may share a Work), so explicit roots can independently cross-check
scope omission. This is a fixture choice, not a product population bound.
For `redLead`, `mixedPeople` and `explicitMale`, red-only returns just redLead;
red-or-black returns all three; red-and-black returns none; none-red returns the
two black-haired leads. `none` never reports an adopted negative. Scope omission
and explicit complete-inventory roots must agree across the isolated corpus.
Unfiltered cast reads preserve named supporting resources without requiring a
wiki Zone, showcase art or a popularity vote.

Prove files (all six personas per file):

- [contextual associations](../../tests/qa/integration/outcomes/catalogue/contextual-associations.test.ts): correlation, frames, predicate modes, uncertainty, disclosure, exact evidence and distinct Work/match continuation.
- [credits and inverse](../../tests/qa/integration/outcomes/catalogue/credits-and-inverse.test.ts): dedicated/generic parity, exact triples and aliases, public inverse coverage, sparse frontier, cursor binding and historical recovery.

The named baseline selection is `context-outcomes-baseline`: both files in one
`bun scripts/goal/goalctl.ts test` call, after pinning pristine product revision
`69eac3ceeaf885be70205a70248bc951e9d81cc9`. Only the independently identified
authored test/declaration/support files may overlay that product checkout. The
later nominated revision advances the original audit tree and cannot replace
the baseline retained in audit state. This corrected future pin has not been
executed. Record the fixed-wave revision, restored corpus generation and source
snapshot separately; none is a substitute product baseline. A fixture unable to
run the original product revision blocks proof rather than advancing the pin.
Prepare a consistent stopped backup once; restore isolated writable copies,
never the shared development stack.
Each build/restore, including startup, migrations, smoke and attestation, has a
600-second ceiling. Baseline evidence must retain test body/title, actual
response, assertion reached, pinned revision and measured preparation phases.
Expected-failure runner success is not product success or a proved declaration.

At specification authoring, the pinned Git object is available but no compatible
context corpus producer, stopped backup or current-run restoration attestation
is staged. The test support refuses that missing prerequisite before any persona
assertion. **No baseline API run or product failure is claimed.** A fixture owner
must supply the manifest and cuts described by `ContextOutcomesFixture` and
`RestoredContextOutcomes` before executing this selection; pinning an executable
baseline and recording preparation remain outstanding. The fixture JSON belongs
under `.temp/qa-context-outcomes/<run-id>/restored.json`, mode 0600; the runner
must construct it from the existing retained-source lifecycle, not hand-edit
IDs or refresh the corpus per persona. Existing source-lifecycle proofs remain
separate. No new capture, browser server, full suite or shared live write is
authorized by this specification.

## Proposed authored admission contracts, 2026-10-19

**Status:** the manager accepted SA1–SA6 and the revision-1 public query and
opt-in credit interface. The earlier pending-approval wording records the
proposal's history; it does not reopen that acceptance. All twelve persona
cells and all runtime, source and rendered proof remain pending. The pristine
product baseline is `69eac3ceeaf885be70205a70248bc951e9d81cc9`; a later wave is a
separate proof target. This section proposes **OA1–OA3 for Program disposition**,
not an admitted model or permission to implement. Acceptance of SA1–SA6 alone
does not authorize these write/storage extensions.

The query implementation owner's attempt-8 dependency report identifies three
missing declarations: association classification/role binding, Statement
coverage/adoption, and retained-credit participation attribution. The existing
owners below were inspected; they are evidence of current admission, not proof
that their composition meets the outcome. This continuation changes this
document only. Independent assertions and pending declarations are preserved.

### Existing admission and proposed owner changes

| Decision | Already admitted and its limit | Proposed authored revision and existing owners |
| --- | --- | --- |
| OA1: association binding | [Semantic definition state](../../services/main/src/modules/semantic/change.ts) seals roles, notation, `workSubjectRole`, star and editorial metadata. `workSubjectRole` chooses edit authority. [Relation facets](../../model/definitions/facet-relation-v1.ts) require an explicit definition/role. Neither declares `appearance`/`credit` or the association's subject roles. | Propose `semantic-definition-v2` in the existing definition model family, and `semantic-change-v2` admission through [semantic routes](../../services/main/src/routes/semantic.ts), [semantic admission](../../services/main/src/modules/semantic/admitted.ts), `semantic/change.ts`, [semantic reads](../../services/main/src/modules/semantic/read.ts), [relation exact-definition reads](../../services/main/src/modules/relation/change.ts) and [Work authority](../../services/main/src/modules/relation/work-authority.ts). |
| OA2: exact coverage and adoption | [Statement meaning/key](../../services/main/src/modules/statement/schema.ts), [record/decision commands](../../services/main/src/modules/statement/graph.ts), [qualification](../../services/main/src/modules/statement/qualification.ts) and [projection normalization](../../services/main/src/modules/statement/projection.ts) do not declare participation coverage or explicit subject-global coverage. `interpretationContext` is opaque proposition scope. | Propose `statement-v2`, a versioned meaning-key domain and an authored `association-occurrence-assertion-v1` property meaning. Extend those owners, [Statement transport contracts](../../services/main/src/modules/statement/contract.ts), [Context routes](../../services/main/src/routes/contexts.ts), [Statement reads](../../services/main/src/modules/statement/read.ts) and [seek coverage](../../services/main/src/modules/statement/seek.ts). Reuse the existing `statement-decision-v1` model and authority. |
| OA3: attribution and retained-credit binding | [Participation schema](../../services/main/src/modules/relation/schema.ts), [relation commands](../../services/main/src/modules/relation/change.ts) and [relation routes](../../services/main/src/routes/relations.ts) admit `creditedName`, not alias/eid/note. The existing author adapter has no complete native/source participation contract. | Propose `relation-occurrence-v2` plus `retained-credit-associations-v1`, an authored compatibility profile of the existing credit owner. Extend those relation owners, [credit writes](../../services/main/src/modules/work/author-credit.ts), [source credit support](../../services/main/src/modules/source/author-credit.ts), [credit evidence](../../services/main/src/modules/source/credit-evidence.ts), [mapped source values](../../services/main/src/modules/source/mapped-values.ts), [registered source adapters](../../services/main/src/modules/source/provider-adapters.ts), [credit reconciliation](../../services/main/src/modules/source/reconcile-author-credit.ts), [retirement reconciliation](../../services/main/src/modules/source/reconcile-author-credit-retirement.ts), [source support routes](../../services/main/src/routes/source-supports.ts) and [credit routes](../../services/main/src/routes/profiles.ts). |

These are proposed new `.ttl`/`.ts` revisions beside
[semantic-definition-v1](../../model/definitions/semantic-definition-v1.ttl),
[statement-v1](../../model/definitions/statement-v1.ttl) and
[relation-occurrence-v1](../../model/definitions/relation-occurrence-v1.ttl), not
edits that assign new meanings to their old IRIs. Authored generated contracts,
validators, manifests and event/receipt registration must be implemented and
qualified together by the separate model/write owner before activation.
There is no proposed change to the authored evidence representation or its
rights policy; new read profiles only compose that existing owner.

### Common command, identity and compatibility rules

The following shapes are proposed closed contracts. `NativeId` means an existing
native Resource identity, `RevisionId` one exact retained native revision,
`Participant` the existing native/external tagged union, and `EvidenceId` a
reference admitted by the existing evidence owner. Examples use metavariables,
not source data or allocated IDs. No new provider, role or identity is inferred
from a string, label, type, NSFW classification or popularity.

Each public write uses a bearer, the existing acting-subject/Access admission
and a required `Idempotency-Key` of 1–128 admitted characters. V2 command digest
domains are distinct from V1. The digest includes the entire normalized input,
the requested profile, exact definition/model revisions, expected heads and
evidence/support identities. An exact replay returns the original terminal
receipt and allocations; the same key with a different input returns `409
idempotency_conflict`. A lost response never licenses allocating another
occurrence, participation or Statement. Unknown outcomes use the existing
operation/reconciliation path and `202`, not speculative success.

A successful owner receipt binds admission, action/scope, authority epoch,
request digest, operation, immutable manifest, model generation, exact component
and revision, predecessor and product data epoch/sequence. It uses the existing
RevisionAnchor, graph receipt and outbox batch. Cross-owner source work also
retains its source intent/receipt and native receipt; a partially completed
intent is not a readable association. New events must be registered before
dispatch is enabled. No second authority, source-support or receipt registry is
introduced.

| Condition | Proposed observable refusal |
| --- | --- |
| Missing/invalid idempotency key; malformed low-level identity/value | Existing owner `400` problem; no lookup of a malformed reference |
| Unknown profile/field, invalid closed combination, role/coverage/attribution mismatch or bound exceeded | `422 invalid_association_binding`, `invalid_statement_coverage` or `invalid_participation_attribution`, according to owner; diagnostics name only submitted fields |
| No bearer / insufficient command authority | Existing `401` / `403` boundary; actor ownership or staff status cannot grant missing authority |
| Hidden or absent explicit occurrence/credit/Statement target | Same existing owner `404` body for identical input; no discovered private counterpart |
| Unreadable submitted definition, participant, frame or evidence | Existing reference refusal (`422 unavailable_reference` for semantic/relation admission); only caller-supplied reference/pointer may be echoed, with hidden/absent equivalence |
| Stale expected head, source selection, compatibility head or model generation | `409 stale_head`, `stale_source_binding`, `stale_association_admission` or `generation_changed`; current identities only when independently readable |
| Attempt to reinterpret an immutable meaning or edit V2 state with a V1 writer | `409 immutable_meaning` or `unsupported_model_revision`; create the explicitly described new meaning/revision instead |
| Missing owner coverage, receipt, source evidence, rights evaluation or an unavailable dependency | `503 association_admission_unavailable`; never accepted, absent or an exact empty result |

These proposed V2 problems do not replace V1's present validation/status rules.
The [command contract](commands.md) and [semantic reference refusals](semantic-model.md#semantic-change-reference-refusals)
still apply. Retired definitions cannot admit new writes. Exact historical
revisions remain readable under current disclosure, without retargeting to a
successor. Adding V2 shapes to a manifest does not rewrite V1 data or decisions.
V1 writes and default reads of V1 records retain their present behavior. V2
records identify their model revision; a V1 mutation cannot silently clear
fields it does not understand. No automatic migration, startup backfill or
query-time repair is authorized by this proposal.

### OA1: authored association-kind and role bindings

Propose the following optional field in `semantic-definition-v2` relation
state; its absence explicitly leaves a definition outside this capability:

```ts
association?: {
  kind: 'appearance' | 'credit';
  workRole: string;           // authored role key of this exact definition
  subjectRoles: string[];     // 1–15 distinct authored role keys
};
retainedCredit?: {
  origin: 'work-author-credit-v1' | 'native-agent-credit-v1'
    | 'source-reported-credit-v1';
  storedRole: 'author' | 'translator' | 'editor' | 'director' | 'artist'
    | 'animation-studio' | 'transcriber';
  subjectRole: string;        // exactly one of association.subjectRoles
  externalNamespace?: { provider: string; namespace: string };
};
```

Only a relation definition can carry it. The Work role must be a required
singleton, equal `workSubjectRole`, and absent from `subjectRoles`. Every
subject role must be declared by that exact revision and allow at least one
participant. The existing maximum of 16 roles, 64 participations, membership
and order constraints still apply. The writer checks the Work participation is
a native Work through the existing Work-authority adapter. Subject alternatives
remain exactly those admitted by the role; an open role can bind an external
participant, Person, character, organization or term without a query type gate.
Additional roles, such as a performed character, remain contextual participants;
they do not become the credit subject unless explicitly listed.

`retainedCredit` is an optional exact compatibility mapping on a credit
definition, not a default on every relation. Its Work role is the explicit
association Work role; its subject role must be the sole mapped retained-credit
subject. `transcriber` is allowed only for the declared source-publication
origin. The `source-reported-credit-v1` tag names this proposed adapter input
variant, not an existing stored credit profile. This mapping is authored in
the same semantic V2 state/command below. Its exact DefinitionRevision is the
compatibility command's `mappingRevision`; no separately mutable mapping table
or undeclared authoring operation is required. `externalNamespace` is admitted
only for a source-reported external subject whose old reader supplied provider
and key without a namespace. It declares that namespace explicitly, must match
the retained provider, and uses the existing external-reference grammar. It
cannot replace an already retained namespace, convert a native transcriber to
an external person, or equate two source author references. Absence of this
required declaration refuses binding; the query cannot supply a default.
Overlapping mappings for an origin/stored-role and provider selection must
agree exactly or activation is refused with `409 ambiguous_credit_mapping`.

The concrete command is `POST /v1/semantic/changes`:

```ts
{
  profile: 'semantic-change-v2', target?: NativeId,
  expectedHead: RevisionId | null, actingSubject: NativeId,
  state: {
    component: 'definition', kind: 'relation', lifecycle: 'active' | 'retired',
    successor: NativeId | null, roles: RelationRole[],
    workSubjectRole: string, association: AssociationBinding,
    retainedCredit?: RetainedCreditMapping,
    // existing notation/star/editorial fields retain their own admission
  }
}
```

Creation omits `target` and requires null head; revision names both. Return
`201`/`200` with `{profile:'semantic-change-v2',component,revision,predecessor,
receipt,sourcePosition,replayed,modelGeneration,manifest}`. The existing exact
semantic GETs expose the retained state and its actual model revision; their
default transport is unchanged, with the opaque `state`/export identifying V2
rather than pretending it is V1 model data. Exact-definition reads return the
binding plus the role-key-to-IRI map. The role IRI remains the existing
`<definition-component>/role/<authored-key>`; the accompanying DefinitionRevision
pins its meaning. Readers never construct a role by trying `work`, `character`,
`author`, provider names or resource types against arbitrary definitions.

`semantic.change` and `semantic:create:root` / `semantic:edit:<target>` remain
the command authority. An active definition binding declares eligibility, not
publication or acceptance. It cannot make a source protagonist mean male.
New constraints on an existing definition require a new exact revision and
admission coverage; a changed role meaning requires a new definition component
and explicit successor, not reuse of the old role IRI. Existing occurrences
keep their original DefinitionRevision and do not acquire the binding when a
definition head advances. An authorized relation revision can explicitly adopt
the new compatible revision under expected-head protection, retaining the
occurrence identity and allocating its new exact participations; this does not
carry old participation-scoped Statements or adoption decisions forward.
Once admitted, the association kind, Work/subject role meanings, retained origin
mapping and declared external namespace are part of that immutable meaning.
Changing them requires the new component/successor path. A compatible revision
may refine bounds or presentation without reinterpreting an old binding.

The kind selector enumerates active authored bindings through a generation-
fenced bounded index, then follows actual Work/subject participations. An absent
binding is an explicitly generic relation, not a guessed association. A missing
index or incomplete activation is unavailable. Kind/role classification is
therefore independent of names and of the order in which source adapters run.

### OA2: Statement coverage, external subjects and adoption

Propose the following mandatory meaning fields for `statement-v2`:

```ts
subject: Participant;
value: SemanticValue;
coverage:
  | { kind: 'participation'; occurrence: NativeId;
      occurrenceRevision: RevisionId; participation: NativeId }
  | { kind: 'occurrence'; occurrence: NativeId;
      occurrenceRevision: RevisionId }
  | { kind: 'subject-global' };
```

Participation coverage declares a proposition about exactly `subject` in the
identified participation of that exact occurrence revision. Admission proves
the participation belongs to that revision and its stored participant equals
the complete supplied native or provider/namespace/key identity. Matching uses
that equality and the authored subject-role binding. A Statement on another
participation, another appearance of the same subject, another revision or a
co-participant cannot satisfy it. Ordinary Statements whose native subject
happens to be a participation ID do not gain this interpretation.

For a retained-credit view, `occurrenceRevision` is its OA3 `associationHead`,
whose immutable receipt pins the original credit/source revision and mapping.
A replacement binding cannot reuse a Statement or adoption that described the
previous binding, even if the original credit ID/revision is unchanged. The
accepted public StatementWitness shape still identifies its occurrence,
subject and exact Statement/revision, with a link to this exact meaning basis.

Occurrence coverage is reserved here for an exact association assertion:
`subject` must be `{kind:'resource',ref:occurrence}`, and value must name
`occurrenceRevision`. Propose an authored property meaning with immutable
notation `association-occurrence-assertion-v1`, no roles, whose precise
proposition is “this exact occurrence revision is asserted as recorded”. It is
created by the same semantic V2 command with `state:{component:'definition',
kind:'property',lifecycle:'active',successor:null,roles:[],
notation:'association-occurrence-assertion-v1'}` and no association/role fields.
Its component is the Statement predicate and its exact revision is
`relationDefinition`. Activation resolves exactly one retained component and
revision for that reserved meaning; an absent or ambiguous binding is
unavailable. This is not a new acceptance operation, arbitrary Boolean
property, type inference or assertion of a character trait. A changed
occurrence revision requires another assertion and adoption; accepting the old
revision cannot bless new participants.

`subject-global` explicitly covers this same native/external subject across
association participations, constrained by its declared applicability and
qualification. An empty applicability means no additional frame restriction
**only in conjunction with this explicit coverage**. It is not a global
declaration in an existing V1 Statement. External subjects are canonical
`{kind:'external',provider,namespace,key}` values; their RDF subject uses the
existing exact external-value representation, never a fabricated Agent or
native equivalence. The meaning key hashes that complete value rather than an
allocated value-node ID. Global coverage does not mean Global adoption or
public disclosure.

V2 proposes the existing authored `value-exact-v1`/`SemanticValue` sum for its
object as well as its subject-reference alternatives, using
[the exact value codec](../../services/main/src/modules/semantic/value.ts).
This is an explicit new Statement admission, not a claim that today's Statement
reader decodes that sum. It preserves structured value nodes, exact lexical,
language/direction, temporal precision/calendar/offset, external qualification,
unknown and no-value. Public predicates and witnesses compare the same
canonical tagged value. The old V1 resource/literal/`some-value`/`no-value`
contract and keys stay unchanged; no arbitrary V1 datatype is cast to a string,
no existential `some-value` is silently reinterpreted as V2 `unknown`, and no
external subject becomes a native resource to fit a read type.

The concrete command is `POST /v1/statements`, discriminated by
`profile:'statement-v2'`. It accepts the V1 record command's `speaker`,
`predicate`, exact `relationDefinition`, `applicability`,
`interpretation`, optional `expectedInterpretation`, optional `qualification`,
`evidence` and `actingSubject`, replacing `subject` with the tagged Participant,
`value` with the existing exact SemanticValue and adding required `coverage`.
Value bounds/normalization come from `value-exact-v1`; the other fields keep V1
bounds: 8 applicability coordinates, 8 interpretation definitions and 16
evidence references. Qualification validation must consume the typed value
without dropping the exact qualification's definition or changing its meaning.
Null or
omitted coverage, an external subject without its namespace, or a relation
occurrence smuggled into the frame coordinate array is invalid. The write
returns `201` (or `200` on exact replay):

```ts
{
  profile: 'statement-v2', statement: NativeId, revision: RevisionId,
  meaningKey: string, subject: Participant, coverage: StatementCoverage,
  operation: string, receipt: string, sourcePosition: SourcePosition,
  modelGeneration: string, manifest: string, replayed: boolean
}
```

Use the existing `GET /v1/statements/{id}` with `profile=statement-v2`,
`revision=<RevisionId>` and the existing required `position` selector for the
exact representation. The new profile admits `context` (`global` or a Realm
IRI, default global), repeated `frame` (0–8), and optional authenticated
`actingSubject`; witness links fix the selected values. Return `200` with
`{profile:'statement-v2',statement,revision,subject,coverage,predicate,
relationDefinition,value,applicability,speaker,meaningKey,meaningBasis,
qualification?,state,evidence,export,sourcePosition,modelGeneration,manifest}`.
The new profile checks current selected adoption and disclosure before exposing
an association Statement or its covered occurrence; hidden/absent meanings have
identical `404`, unavailable acceptance is `503`, and unauthenticated Realm
selection is `401`. The record receipt still lets its writer inspect the
unadopted command result; this public profile adds no draft inspection mode.
V1 records remain readable with their existing
default and meaning keys. A request for a V2 record without the V2 profile,
including an explicit V1 request, returns `409 unsupported_model_revision`
with the exact V2/schema link, not a flattened substitute. New witness links
select the admitted representation. Public query projection
is unchanged: `StatementWitness.subject` is the Participant, and `occurrence`
is the pinned occurrence or null for `subject-global`. A successful record
receipt is not an acceptance receipt.

Use a separate `statement-meaning-v3` domain, including the normalized subject,
coverage discriminator and every exact coverage identity, in addition to V1's
predicate/definition/value/applicability/interpretation and qualification tuple.
It preserves the exclusion of speaker, support count and acceptance Context.
Existing qualified/unqualified key domains remain byte-for-byte unchanged.
Neither adding evidence nor a Context default may change coverage for an
existing Statement ID. Such a change records a new Statement and requires its
own decision; it does not mutate old meaning or transfer old acceptance.

Frame normalization stays with `statement/projection.ts` and
[frame reading](../../services/main/src/modules/projection/frame-read.ts).
Normalize the union of occurrence and Statement coordinates under the selected
Work/release/realization/continuity/event/position dimensions; reject occupied
incompatible slots or Work mismatch. Do not insert occurrence or Realm IDs as
coordinates. `interpretationContext` retains its opaque qualification meaning;
it neither selects a Realm nor proves coverage. Asserted/uncertain/conflicting
qualification and independent gender evidence retain SA2's existing rules.

Recording reuses `statement.record`, the existing speaker scope and current
reference/evidence authority. Adoption reuses exactly:

```ts
POST /v1/statement-decisions
{ profile: 'statement-decision-v1',
  target: {kind:'statement',statement}
    | {kind:'qualified-fact',meaningKey,support:NativeId[]},
  acceptance: {kind:'global'} | {kind:'realm',realm},
  expectedDecisionHead: RevisionId | null,
  outcome: 'accepted' | 'rejected' | 'withdrawn', actingSubject: NativeId }
```

Return the existing `statement-decision-v1` slot/decision/outcome and command
receipt fields. Qualified-fact targets retain their existing 1–32 submitted
Statement support identities and exact-meaning/active-support validation;
neither a caller-supplied list nor an empty result establishes acceptance.
`statement.decide` retains the existing
`classification:decide:global` or `classification:decide:<realm>` scope. The
occurrence assertion and every matching trait must independently resolve to
accepted, active support at the same read position. Global reads resolve only
Global acceptance, including for owner/staff. Explicit Realm reads first prove
current Realm access and pin its active classification Context revision and
inherit/isolate policy. Resolve local rejection, local acceptance and confirmed
absence/withdrawal through the existing acceptance owner; inherit Global only
where that pinned policy permits it. An unreadable local slot is unavailable,
not absence. Return the selected query Context even when a support was inherited;
retain the actual slot/decision provenance internally and through evidence.

This composes with existing accepted meanings rather than installing another
occurrence adoption store. V1 Statements without explicit coverage remain
valid for their existing consumers and never silently qualify as scoped or
subject-global traits here. A retained adapter may create a new covered
Statement with exact source support; it cannot rewrite the original Statement
or reuse its meaning key/decision. Private co-participants, unrevealed positions,
revocations and rights restrictions still withhold the whole affected witness
before matching, hydration and counts.

### OA3: participation attribution and retained-credit compatibility

Propose `relation-change-v2` at the existing `POST /v1/relations/changes`.
Its generic branch retains V1's occurrence/expected-head, exact definition,
participations, applicability, lifecycle, evidence, revelation and acting
subject fields. Add an optional participation `sourceIdentity`:

```ts
{
  provider: string, namespace: string, key: string,
  alias: string | null, eid: string | null, note: string | null
}
```

Provider/namespace use the existing qualified external-reference grammar;
key/eid/alias are nonempty when present, bounded to 200 characters, and contain
no control characters. Note is at most 2,000 characters. All six fields are
required if `sourceIdentity` is present; null means no reported value, not an
empty string or permission to infer it. Omitting the object means no source
identity is asserted for that participation. It is allowed for native and
external participants: a provider identity can attribute a native participant
only through an independently admitted correspondence, never by equating keys
or names. `creditedName` keeps its existing language-tagged shape and 200-
character bound. It is not automatically the participant's name or source alias.

Add owner-retained `attributionSupports` per participation, 0–16 entries, using
the following closed shape (at most 32 distinct bases and 64 distinct evidence
IDs across a command):

```ts
type AttributionSupport = {
  basis:
    | {kind:'source-credit'; support:NativeId}
    | {kind:'native-credit'; credit:NativeId; revision:RevisionId}
    | {kind:'source-binding'; binding:NativeId}
    | {kind:'selected-publication'; decision:NativeId};
  fields: ('creditedName' | 'provider' | 'namespace' | 'key'
    | 'alias' | 'eid' | 'note')[]; // 1–7 distinct fields actually present
  evidence: EvidenceId[];       // 1–16 distinct exact citations
};
```

Every asserted `sourceIdentity` field requires such an admitted support; an
absent/null field asserts no value. The basis resolves through its existing
owner to the exact original revision, observation/child occurrence, reviewed
mapping, source intent/receipt and native receipt. A native-credit basis can
attest only fields actually authored there, never an Agent's current display
name or invented provider metadata. The writer seals a per-participation
field-to-basis/evidence map with its allocations in the same command receipt.
A submitted evidence ID must resolve to that exact retained representation
and authorized claim; a locator or matching quote alone cannot establish the
mapping. Hidden/absent submitted support receives the same reference refusal;
an unreadable owner or incomplete receipt is unavailable.

Extend the existing verified source-credit reader's internal result, not the
public query schema, to return `{provider,namespace,sourceKey,role,roleKey,
creditedName?,sourceIdentity?,attributionSupports}`. Its existing adapter must
verify those values and field dispositions against exact retained bytes and
the reviewed mapping revision; the compatibility writer rechecks them. For
selected-publication attribution, the same existing publication owner returns
this typed result from its retained attribution/decision. Missing alias/eid/note
maps to null only when the source mapping explicitly records absence; a field
the adapter cannot interpret makes attribution unavailable. This supplies an
explicit owner boundary instead of reading arbitrary provider JSON in a query.
The receipt retains the existing conversion's `mappingRevision`, `sourceDigest`
and exact mapped-field pointers/dispositions from `mapped-values.ts`. That
reviewed source-mapper token is distinct from the compatibility command's
`mappingRevision` (an OA1 DefinitionRevision). Selected-publication proof instead
pins its existing structure verification profile, structure revision and
retained attribution fields; no conversion is invented. A changed field
interpretation requires a new registered source mapping/profile revision and
new binding, never changed behavior under an old mapper token.

This is storage/write metadata: the accepted public Participation shape remains
unchanged, with disclosed citations projected by the evidence owner. Subsequent
independent supports are recorded by the existing source or Statement command,
not by overwriting the occurrence's original fields. An adopted OA2 assertion
of that exact view revision can independently support its sealed participation
fields with its own citations. It cannot silently change any of those fields.

The generic response is `201`/`200`:
`{profile:'relation-change-v2',occurrence,revision,predecessor,receipt,
sourcePosition,replayed,modelGeneration,manifest,participations:[{id,role,
participant,position?,creditedName?,sourceIdentity?}]}`. Allocations are sealed
in the manifest and reused on replay. A generic edit follows the current
owner's allocation rule: its new revision has new exact participation IDs.
An old participation-scoped Statement therefore cannot float to a new revision.
Read `GET /v1/relations/{id}/revisions/{revision}` with
`profile=relation-change-v2` and its existing required authenticated
`actingSubject` and `position` to recover the exact admitted identities and
attribution. Its `200` read envelope retains the V1 occurrence/revision,
definition, lifecycle, applicability, revelation, operation, source position,
manifest and model-generation fields, with the V2 participations and their
sealed field/support map; retained views additionally return origin,
mappingRevision and compatibilityReceipt. Keep the current authorization and
spoiler boundaries. `GET /v1/relations/{id}` with the same query selects the
current exact head. A V1 read request for a V2-only record returns `409
unsupported_model_revision` with its V2/schema link. V1 writes cannot mutate
a V2 head. The visitor link uses the separately specified evidence profile,
which rechecks public adoption instead of bypassing these owner boundaries.

For retained credits, the same V2 route has a separate, closed compatibility
branch. It does not dispatch `changeRelationOccurrence` to create a duplicate:

```ts
{
  profile: 'relation-change-v2', mode: 'bind-retained-credit',
  retained: {
    profile: 'work-author-credit-v1' | 'native-agent-credit-v1'
      | 'source-reported-credit-v1',
    credit: NativeId,
    origin:
      | {kind:'stored-credit'; revision:RevisionId}
      | {kind:'source-binding'; binding:NativeId; proposal:NativeId;
          conversion:NativeId; record:NativeId; observation:NativeId;
          sourceOccurrence:string; sourceOrdinal:number}
      | {kind:'selected-publication'; decision:NativeId; source:string;
          record:NativeId; observation:NativeId},
  },
  expectedAssociationHead: RevisionId | null,
  mappingRevision: RevisionId,
  attributionSupports: AttributionSupport[],
  actingSubject: NativeId
}
```

The proposed `retained-credit-associations-v1` profile is an authored adapter
of the existing Work/source credit owner. Its mapping revision records exact
origin profile/role values, OA1 DefinitionRevisions, Work/subject role keys and
the optional explicit external namespace. Retained binary credits do not gain
additional participants through this adapter. It explicitly covers each of `author`,
`translator`, `editor`, `director`, `artist`, `animation-studio`, and the
source-publication `transcriber`. These are exact admitted stored-role values
from [credit roles](../../services/main/src/modules/work/credit-roles.ts), not
labels interpreted by the query. Each mapped definition must declare
`association.kind:'credit'`; its authored role map is the only role-IRI source.
The command does not accept caller-supplied replacement Work, participant,
ordinal, role, alias or note. The owner loads and verifies those values and the
exact support/mapping receipts before allocating participation identities.
The origin union is closed: stored-credit is required for the two stored
profiles; either source-binding or selected-publication is required for
source-reported. For source-binding, `binding` is the retained native Work
adoption binding, `sourceOrdinal` is 0–127, and `sourceOccurrence` is the source
owner's exact child-occurrence token. Its immutable intent/receipts must resolve
to the supplied proposal, conversion, record and observation; it has no
fabricated selection revision. For selected-publication, `decision` is the
exact selected WorkStructurePublicationDecision and `source` its retained
`urn:rezics:work-source:…` reference; the source reader proves its record,
observation, structure and exact structure revision from that decision. This
origin has no proposal/conversion requirement. Both branches verify the
existing reader's credit ID and role/ordinal, not a newly derived public ID.
The source readers and support owner verify these tuples before binding.

The result adds `{associationHead,compatibilityReceipt,origin,mappingRevision}`
to the V2 response, with `origin` echoing the exact verified retained tuple.
`occurrence` is the retained credit ID. For a stored credit, `origin.revision`
remains its exact retained credit revision.
The V2 association view's `revision` is always the credit-owned compatibility
RevisionAnchor `associationHead`. It seals the original stored-credit revision
or source tuple, exact definition/mapping, participation IDs and attribution.
Thus even a source-reported credit with no historical credit revision has an
honest exact view revision; the receipt does not invent such history. Existing
V1 credit/adapter reads retain their old revisions and representations. The
compatibility receipt allocates one exact set of participation IDs for that
origin and mapping. Retries/concurrent requests cannot allocate a second set;
a changed mapping requires expected-head protection and a new compatibility
receipt/view revision.
It also requires new covered Statements/adoption pinned to that binding;
the old binding remains immutable and cannot adopt the replacement implicitly.
The original credit, support, publication and retirement owners remain the
sources of truth. No new `RelationOccurrence` with a competing ID, credit copy,
authorship edge, native Agent or public equivalence is written.

V2 relation exact reads address the credit ID plus this view revision; they
resolve only that sealed receipt, never the newest binding for an older view.
The receipt's origin links retain the original credit revision or publication
decision. A bare original credit revision does not implicitly select a new
compatibility mapping. The current V2 read can select the active binding only
with its current coverage fence and returns its exact view revision.

| Retained origin | Required exact mapping and identity preservation |
| --- | --- |
| Human-confirmed external `AuthorCredit` | Keep `credit`, `creditRevision`, Work, provider/namespace/key, native ordinal, source role key and native/source receipts. Map Work and subject participations from the admitted profile/mapping revision. Preserve the source occurrence and observation, not a name-derived participant. |
| `NativeAgentCredit` | Keep the existing credit/revision, Work, exact native participant and stored role. Attribute source identities only with verified correspondence. Agent existence is neither publication nor permission to reveal that Agent. |
| Source-reported author reference | Preserve the existing source reader's credit ID, binding/selected-source revision, complete provider/namespace/key and ordinal. Keep `source-reported` provenance; compatibility admission is not human confirmation or Global adoption. |
| Selected-publication author/transcriber | Preserve the IDs returned by [selected-publication credits](../../services/main/src/modules/work/sourced-publication-credits.ts), its exact publication decision/revision and original external author or native transcriber. Withdrawal invalidates this binding even when source custody remains. Never reinterpret transcriber as author. |
| Performer/character/Work or repeated contextual role | Use the one already admitted generic occurrence and all of its exact role participations. A source reference to it is another explicitly corresponding support on that occurrence, not another retained-credit binding with a second occurrence ID. Its first occurrence is written through the relation owner; a reader cannot generate occurrences or infer a character from a performer. |

The compatibility profile declares mappings, not arbitrary stored-value
defaults. The legacy external-author adapter remains readable under its old
definition. Its prior author-role interpretation is not silently applied to
every native role. No retained record is promoted to an association until the
new exact mapping and its receipt exist. If a legacy derived credit ID is
ambiguous for the submitted source occurrence/revision, reject with `409
ambiguous_credit_origin`; never merge equal names/keys, allocate a substitute
public ID in the reader, or guess which original was intended. The owner must
correct correspondence explicitly before admitting it.

In particular, a selected-publication author's existing `<externalId>/author`
key denotes that retained author reference; an explicitly authored namespace
does not assert a universal Person identity. The transcriber's existing key is
a native attribution reference, not an external provider identity. It supplies
the native subject, without a fabricated `sourceIdentity` or equivalence.
Publication `author` text and current Agent display names are not automatically
`creditedName` or alias; a reviewed field binding and admitted language are
required for those separate assertions.

Binding a retained credit requires the existing `relation.change` Work-edit
admission **and** the originating credit/source owner's current validation.
Source-derived support continues to require the existing catalogue-import
exposure and source-use authority; the public relation route does not grant
them. A native Work editor may bind original native credit evidence without
gaining access to private source support. Source commands and reconciliation
can invoke the same admitted owner function when they already hold all those
authorities, retaining both source and native receipts. A mere read, model
activation or mapper success never creates the compatibility receipt.

Aliases, `eid`, notes and credited names must come from exact retained fields
under the reviewed mapping. A missing field stays null/absent as declared;
an unsupported or unknown mapping is not a successful empty value. Provider
keys remain provider/namespace qualified through all joins and cursors. Two
supports for one native credit stay two support/citation identities. Withdrawing
one support changes that support's current availability and source generation;
it does not erase another support, the original credit or a human decision.
Replacement source observations retain explicit correspondence to the credit;
no query-time re-anchoring or new credit allocation occurs.

Both the generic template and dedicated opt-in credit GET hydrate these same
owner witnesses. Existing [credit template](../../services/main/src/modules/query/templates/work-credits.schema.ts),
[source author reads](../../services/main/src/modules/source/author-name-read.ts)
and default credits keep their existing response/default behavior. Their
source-reported labels are not substitutes for the new participation evidence.
An incomplete compatibility projection for a declared retained-credit class
prevents activating its association read coverage; it cannot make eligible
credits silently disappear from the new profile.

### Evidence, generation fences and bounded reader composition

All three extensions consume current Access/disclosure, reading-position,
rights-evaluation and adoption authorities. The [evidence reader](../../services/main/src/modules/wiki/evidence-read.ts)
and [quotation policy](../../services/main/src/modules/wiki/quotation.ts) alone
produce `wikiClaimEvidence`: exact source Work, immutable representation digest,
locator/method, evidence ID, submitter, rights basis and quote-withheld state.
A source record, conversion, receipt, credited name or synthetic digest is not
itself an authorized quotation. Original native attribution also needs a real
admitted evidence representation. Unknown rights cannot be replaced by a
fabricated permissive basis. Withholding a quote must preserve the allowed
exact citation; hiding its source or participant must not leak an ID, locator,
snippet, count or executable link.

Source refresh/support withdrawal/selected-publication changes invalidate the
corresponding source dependency position. Definition, coverage or compatibility
mapping changes advance the existing model-generation dependency; restore
changes the product data epoch and requires rebuilding fenced seek coverage.
The new projection's coverage receipt must bind all of these plus its definition
and compatibility revisions and contiguous outbox position. It becomes usable
only after owner writes, support reconciliation and a complete bounded index
rebuild/catch-up have finished. A stale or missing coverage receipt is `503`,
not a partial index treated as the full catalogue. Historical credit/Statement
revisions and evidence keep their original meaning and locator. Read recovery
uses SA6's `409 stale_query_result` restart; write recovery resolves its exact
receipt before re-admission. Neither pins obsolete authority.

The proposed per-request composition uses the existing template's 64-root,
1–64-result, 256-candidate and two-logical-hop limits. Within that request,
hydrate at most 64 occurrence witnesses, 64 participations per occurrence,
8 frame coordinates, 16 predicates per mode and batches of at most 20 decision
targets; retain the existing public Statement/support batch ceiling of 512.
Share one WorkReadSession budget (currently 160 graph calls, 4 MiB graph bytes,
512 KiB per graph response and 10 seconds), including all hydration, authority,
frame/source dependencies and final fences. Helpers cannot reset that budget
or multiply it by giving each Work, role or support its own session. These are
proposed hard admission bounds, not measured latency or capacity proof.

Candidate/Statement/support scans carry exact ordered frontiers. A hidden-only
page may return no items and a continuation, without exposing its hidden IDs.
The frontier continues past 800 private candidates across requests; a scan cap
does not declare exhaustion. Work matches use the already specified nested
occurrence continuation, bound to its parent Work and the whole selection.
Citation/support collections also remain bounded: the accepted witness has
1–16 exact citations per claim; more support must expose an evidence-owner
continuation with method/body, source/model/reader binding and truthful complete
state before it can claim completeness. That continuation must enumerate the
same support set on both credit surfaces. It cannot silently truncate, coalesce
independent evidence IDs, or present source custody as read permission.

Propose an opt-in `association-evidence-v1` read profile on the existing
`GET /v1/relations/{id}/revisions/{revision}` for that continuation. It is a
read adapter to the existing evidence/support owners, including retained-credit
compatibility views, not a new evidence store. Its closed query requires
`profile`, `context` (global or selected Realm), `position`, `claim` and
`claimRevision`; admits repeated `frame` (0–8), optional authenticated
`actingSubject`, `limit` (1–16, default 16), and an opaque `cursor` (at most
2,048 characters). Retained views use the exact OA3 view revision in the path.
`claim` must be this occurrence or an exact covered Statement on this witness;
`claimRevision` must be the actual occurrence/Statement revision. An arbitrary
native Resource cannot be used to probe evidence. The link fixes these values;
changing them invalidates its cursor.

The proposed response is `{profile:'association-evidence-v1',occurrence,
revision,claim,claimRevision,sourcePosition,modelGeneration,items:Citation[],
nextCursor,complete,count:{value,kind:'exact-page',total:null}}`, ordered by
independent support/evidence identity with no duplicates. Every page repeats
the association's adoption, reference disclosure, spoiler and rights checks.
This opt-in public read accepts visitors for authorized Global evidence; a
Realm or acting-subject selection requires its existing current authority.
The existing relation default's authentication and response are unchanged.
Missing/denied witnesses have identical `404`; invalid shape is `422`, changed
binding `400 invalid_cursor`, invalidated source/model/restore `409
stale_query_result` with a GET restart retaining the safe selection and
omitting the obsolete cursor/pin, and unavailable/budget failure `503`.
Complete means the authorized support frontier is exhausted. A witness's
`links` advertises `rel:'citations'`, method GET and the exact continuation URL
when its initial 16 citations are incomplete; absence of that link asserts
exhaustion. This adds no fields to the accepted witness or query envelope.
Program must disposition this read admission with OA3; it is proposed, not an
already available route profile or proof that citation hydration fits a budget.

If filtering or hydration cannot finish the next witness within those bounds,
return a resumable frontier only at a boundary that preserves the witness's
required exact meaning, or `503 query_budget_exceeded`. Do not emit a partial
witness as complete or relax predicates to fit a budget. Current disclosure
is checked again before every page and final emission. A changed reader,
selection or surface is `400 invalid_cursor`; an invalidated source/model/
restore dependency requires SA6's explicit stale-result restart.

### Program disposition and separate implementation prerequisites

OA1 proposes the authored binding, explicit namespace declaration and
no-retroactive-classification rule. OA2 proposes exact typed values,
coverage/key/occurrence-assertion semantics using existing DecisionSlots, and
the explicit V2 public Statement read. OA3 proposes participation attribution,
one credit-owned compatibility view with preserved origin identity, and the
opt-in evidence continuation. Program must read and accept, amend or reject
these proposed revisions, command/read/error contracts and activation rules
before any model/write implementation. They are not approved merely because
their public query consumer was accepted.

After disposition, a separate model/write owner must supply generated admission,
write/read/receipt and recovery coverage for all three contracts, and a complete
retained-credit mapping/coverage receipt. Counterexamples include a correct
role name on the wrong definition, same character in another occurrence or
revision, equal external keys under different namespaces, an unscoped V1
Statement, a Realm interpretation IRI mistaken for acceptance, source support
withdrawal with an independent human support, a repeated performer in another
release, and hidden-only frontier pages. None can be repaired in the query by
guessing, widening joins, inferring authority or weakening the twelve tests.
The remaining authored data is explicit: active DefinitionRevision/role
bindings for each appearance/credit meaning, registered source mapping/profile
revisions and field dispositions, the source-reported external namespaces,
and evidence/compatibility receipts for the actual retained records. This
proposal supplies their admission contract, not those allocated identities or
verified source data. They must be authored by their existing owners after
disposition; no guessed role keys or successful placeholder receipts suffice.

Remaining proof prerequisites are separate: the corpus producer now exists
outside this specification, but compatible retained bytes/reviewed mappings,
the consistent stopped backup, a pristine-baseline test-only overlay and a
current-run restore attestation still require their fixture owner's work.
No corpus preparation or baseline/integration/browser/shared-stack execution
is authorized by this continuation. G-2764 remains the exclusive query/read
implementation owner and resumes only after the required contracts are
disposed, admitted and implemented. This proposal neither resumes that worker
nor authorizes an individual wave landing or product proof.
