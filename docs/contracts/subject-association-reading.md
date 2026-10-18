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
`79be80d4d0e1cad1639b6a65e8f0795d6a95929a`. Only the authored test/declaration/support
files may overlay that product checkout. Prepare a consistent stopped backup
once; restore isolated writable copies, never the shared development stack.
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
