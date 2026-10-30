# Public document composition and context traversal proposal

Status: implementation-ready proposal pending Search, Semantic, Content and Web owner adoption.
This artifact closes the known In-row design gap in document composition and the existing
context/thread aggregate obligation. It supplies neither a runtime implementation nor a native pass.
Formatting acceptance of this file establishes only that the specification artifact is present.

The reader must be able to read a selected public document on a configured subject page,
receive the same instructions in public metadata, and continue a subject's discussion and
relations without changing its selected Context or borrowing another reader's authority.
Recipes exercise this generic boundary; they do not acquire a separate document producer,
document format, permission, Recipe schema or page renderer.

## Authority and adoption boundary

[Subject pages](subject-pages.md) remains the authority for page organization, honest states,
server rendering, traversal and Realm selection. Its Realm contract governs current publication,
Context, ban and fallback behavior. This proposal selects an implementation for that boundary;
it does not replace it. [Composition](../packages/composition/README.md) owns inert documents,
registry validation, planning and publication limits. [Presentation](../services/kernel/src/presentation/README.md)
owns aggregate admission, public statement audience, standalone dispatch and session custody.

[Content](../services/kernel/src/content/README.md#authored-field-documents) owns document
disclosure, immutable body identity, rights, erasure and subject-thread readers.
[Definitions](../packages/definitions/README.md) owns document references and released types.
[Document](../packages/document/README.md) owns snapshot validation and text projection.
The [existing capability obligation](goals/search.capabilities.md#subject-context-and-traversal)
and [publication acceptance](../apps/web/tests/native/README.md) retain their independent status.
No historical receipt is reverified or promoted by this design.

The following are proposed cross-owner choices, all pending adoption:

- Search and Web: one generic `Document` component bound to one property, not a body ID.
- Search and Semantic: an implicit subject dependency, charged once, selects the exact reference.
- Search and Content: `document.get` remains the sole body disclosure operation.
- Search and Web: an aggregate document binding is the shared input for prose and instructions.
- Search, Semantic and Web: a final selected-subject guard rejects changed selection without replay.
- Search and Content: discussion previews use the existing subject/place/kind thread operation.
- Search and Web: one explicit node continuation in `pages.read` replaces that node's preview read.
- Search and Community: late publication change produces retryable whole-page failure on this path.

Owner adoption moves durable additions into the cited authorities and leaves this file as the
implementation brief and frozen scenario source. Do not create another authoritative topic in
rezics-next-discussion. No material is being moved from that repository in this change.

### Existing declarations versus proposed names

These declarations are callable in the inspected source:

| Declaration                                              | Actual location and role                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `platformRegistry`, `PageRead`, `PageContext`            | `packages/composition/src/registry.ts`; closed components and descriptor types        |
| `readCost`, `planReads`, `shownProperties`               | `packages/composition/src/reads.ts`; cost and canonical descriptor planning           |
| `pickLanguage`, `localeChain`                            | `packages/composition/src/strings.ts`; deterministic language fallback                |
| `readPage`, `PageReadError`                              | `services/kernel/src/presentation/reads.ts`; aggregate executor and validation errors |
| `pageRoutes`                                             | `services/kernel/src/presentation/http/pages.ts`; `pages.read` request and response   |
| `PageResponseSchema`, `extendPageResponseSchema`         | `presentation/http/page-contract.ts`; common response schema                          |
| `documentRoutes`, `readDocument`                         | `content/document-routes.ts`, `content/document-read.ts`; public route and reader     |
| `readCandidateDisclosure`                                | `semantic/disclosure.ts`; disclosure evidence, explicitly not authorization           |
| `readSubject`, `readContext`, `publicContextEligibility` | `semantic/subject.ts`, `semantic/context.ts`; native facts and Context authority      |
| `readRealm`, `readPublication`                           | `community/realm.ts`, `community/publication.ts`; current Realm and publication       |
| `withPublicStatementReader`                              | `semantic/statement-disclosure.ts`; sticky public audience with unchanged caller      |
| `listSubjectThreads`, `readSubjectThread`                | `content/subject-threads.ts`, `content/reads.ts`; indexed page and current hydration  |
| `readableDocument`, `DocumentValue`                      | `apps/web/src/features/pages/values.tsx`; validation and prose rendering              |
| `subjectBody`, `pageContext`, `loadSubjectPage`          | `apps/web/src/features/pages/subject.tsx`; aggregate consumer                         |
| `subjectJsonLd`, `serializeJsonLd`                       | `apps/web/src/features/pages/jsonld.ts`; public metadata and script escaping          |
| `CompositionRender`, `PageData`                          | Web `render.tsx`, `data.tsx`; registry render and prepared page values                |

All shorter Kernel paths in that table are relative to `services/kernel/src/`.
The actual `readDocument(dependencies, id, {actor, deadline})` returns a document plus
anchors, or null. Its internal import `origin` is removed by `documentRoutes`; account origin
is public. An aggregate must not serialize `DocumentView` directly instead of the public route DTO.

`Document`, `DocumentBinding`, `selectPageDocument`, `guardPageSelection`, `subjectThreads`
and `PageContinuation` below are proposed names. They are not current exports or endpoints.
The code examples are frozen future contract examples, not imported modules or executable ports.
The current registry has no document descriptor. `Summary` reads the subject; current
`ThreadList` and `ReviewList` have no read callback. These are the specific missing bindings.

## Document planning operation

Add the following closed component to the shared registry. Its only data prop is a safe CURIE;
`id` retains the composition envelope's existing ID validation. It has no slots.

```json
{
  "type": "Document",
  "props": { "id": "method", "property": "schema:recipeInstructions" }
}
```

Its logical descriptor is:

```ts
type DocumentRead = {
  kind: 'document';
  id: string; // Page subject UUID, never a document UUID.
  property: string; // One released document-valued property.
  context?: string; // Internal, resolved by page authority; absent means Global.
};
```

The component returns null when `page.subject` is null. It cannot accept an arbitrary URL,
document ID, candidate, digest, language, licence, author, selector expression or permission.
The compiler verifies the property's released datatype when binding the active definition
release, using the same release/profile compatibility boundary as other released components.
Unknown or non-document properties fail publication compatibility; they never become a
best-effort generic network read. Existing immutable profiles remain valid without this node.

For every document descriptor, `planReads` inserts its subject dependency before the descriptor,
in document order. That dependency is `{kind:'subject',id,context?}` with the same effective
Context. It is an ordinary planned read even when no header or Statements component needs it.
Its key is visible in `plan.reads`; the node maps to the document descriptor's key.
Dependencies have no synthetic visible node and no hidden read budget.

`SubjectHeader`, `Statements`, `MoreStatements`, `Sources` and the implicit dependency dedup
when their effective subject and Context match. Canonicalize after default Context binding;
omitted Global and explicit Global are the same effective read. Distinct Contexts never dedup.
Store the same effective identity in probe reuse, pending reads, results and sessions.

Publication validation must use that expanded plan, including implicit dependencies. Extend
the existing `readCost` switch explicitly: subject costs 1; document costs 1. Do not fall
through to `read.limit`, which is absent on a document descriptor. `planReads` also checks
the total cost at the executor boundary; a valid saved template alone is insufficient.

### Cost

- Touches: at most 256 composition nodes in registry slot order, canonical descriptors and implicit subject keys; no database, body or permission read.
- Bound: retain 65,536 canonical composition bytes, depth 8, 16 distinct reads and 128 summed slots. One property-bound document reserves one slot plus its shared subject slot; at most 15 document descriptors fit beside their one subject.
- Growth check: freeze 1, 8 and 15 distinct document properties, repeated nodes up to 256, and 16 versus 17 expanded descriptors; record visited nodes, unique keys, cost and dependency count. At fixed document size, unrelated subjects, documents and revisions cause zero planning work.

## Selected public reference operation

`selectPageDocument` is a proposed pure shared selector. Kernel uses it after the public
subject dependency; Web uses it only to verify the aggregate binding, never to fetch a body.
Keep it portable in `@rezics/composition`, using a narrow structural input rather than importing
Kernel or client declarations into this package. It must not accept internal stored bodies.

The input consists of the effective descriptor, current public `subject.get` representation,
the request's validated ordered language list, and the subject's publicly disclosed original
language. The statement DTO already exposes `id`, `rank`, `property`, `value`, qualifiers,
references and `rezics.revision`. Its `id` is the candidate/statement identity to bind.

The candidate reference shape is exactly:

```json
{
  "language": "en",
  "document": "00000000-0000-8000-8000-000000000030",
  "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

`document` here is a UUID string, not a snapshot. The example digest is a symbolic immutable
fixture value; native fixtures must use the actual digest returned by the ordinary producer.
The implementation must not compute a new digest in the composition package or Workers.

Selection is deterministic and bounded by the existing public subject representation:

1. Require successful current subject output for the effective subject and Context.
2. Look only at `subject.statements[property]`, not related subjects, history or candidates APIs.
3. Require matching property ID, datatype `document` and concrete `value.type === 'value'`.
4. Require canonical document UUID, language and lowercase 64-hex digest in the reference.
5. Exclude deprecated rank and any statement with a spoiler level other than explicit safe zero
   or no spoiler qualifier. Reuse the existing public metadata spoiler rule; malformed qualifiers
   cannot turn a hidden statement into a selected instruction.
6. Among remaining candidates choose preferred rank if any, otherwise normal rank.
7. Select language within that rank using the page's first requested language as locale,
   `pickLanguage` and the public original-language fallback. If the list is omitted or empty,
   use `en` as the presentation fallback locale. Never source a preference from another account.
8. Within that language, choose the smallest statement ID in code-unit order. Do not use
   arrival order, internal row order or body availability as a tie-breaker.

The language list continues to use existing `validateHitOptions` admission, rather than a new
language grammar. Its first entry anchors presentation fallback; it still forwards unchanged to
Search and subject hydration under their owning contracts. This first-entry choice is proposed
for owner adoption so Kernel, Web and the Recipe serializer cannot choose different languages.

This rule is rank-first, matching the existing About summary and JSON-LD rank selection.
It intentionally does not downgrade a preferred foreign-language candidate to a normal local
one. The visible document carries its selected `language` and the existing language tag.
Other eligible candidates remain discoverable through Details under existing authority.
If `resolution` declares that property unresolved with no adopted statement, there is no
selected body; do not read a competing candidate directly to invent a resolved fact.

The selector returns null or this closed binding seed:

```ts
type DocumentSelection = {
  subject: string;
  context: string;
  property: string;
  candidate: string;
  candidateRevision: number;
  document: string;
  language: string;
  digest: string;
  rank: 'normal' | 'preferred';
};
```

The subject DTO's revision is a page consistency observation, not the document revision.
`candidateRevision` is `statement.rezics.revision`. Content's `document.revision` must equal
that candidate revision. Do not compare it to the subject's later overall revision.
The selector is not permission evidence: it only chooses an already disclosed public reference.

### Cost

- Touches: one named property in one already charged public subject response, its existing qualifiers and reference values; no history, language lookup, permission preparation or Content read.
- Bound: the existing property slot admits at most 32 selected facts, so this selector inspects at most 32 public references and returns at most one binding. It adds no candidate enumeration or replacement search. Its subject dependency retains Semantic's at-most-512 descriptive facts, 64 relation properties, 12-preview entries plus one sentinel per relation property and at-most-256 related IDs; those native reads and Access checks are charged separately, not hidden inside the selector's one output slot.
- Growth check: use the native owner's maximum admitted property selection and its existing subject bounds, then grow unrelated subjects and historical candidates at 64, 512 and 4096. Record public statements inspected and selected bodies; history growth must not add selector or body dispatch work.

## Document aggregate execution operation

Extend the executor's closed union in both composition and `presentation/reads.ts`.
Admit the full logical plan and dependencies before dispatching anything beyond required routing
and selection controls. Preserve raw alias validation, owned plain JSON copying, escaped sorted
pointers and validation-before-dedup. Added fields use the same UUID and CURIE validation.
Reject unknown descriptor fields, including client-supplied binding evidence.

There is one aggregate call from the page loader. Within it there is one subject-dependency
phase, followed by one dependent execution round. It is not a recursive query interpreter:

```text
admit expanded plan -> reuse/probe public subject -> select each named reference
  -> one round of remaining standalone leaves -> final page guards -> serialize
```

Independent leaves may run beside the subject phase if admitted already. Documents wait for
their own subject. No leaf can discover further document leaves. Links, search hits, thread
cards, mentions and document nodes cannot cause per-card requests for documents or subjects.
The scheduler shares the existing maximum of four concurrent dispatches across both phases;
it does not allocate another four for documents. Release the page route's admission slot before
subreads, as current `pages.ts` does. Never hold a subject connection while acquiring a body home.

Within this request, identical effective document GET leaves share one dispatch after selection,
including their authorization/session/audience identity. Keep each logical descriptor's reserved
slot even if two leaves coalesce, and validate each property binding independently against the
shared public response. Never dedup across requests or principals. Merge genuine dependency
tokens before starting dependent leaves, then merge all leaf and final-guard observations into
the same scoped aggregate session using existing token helpers; no fabricated position is valid.

For a selected binding, construct precisely `GET /v1/documents/{selected.document}` through the
same composed dispatch as other standalone reads. Forward the caller's authorization and
current aggregate session header. Preserve deadline, native admission and public statement
audience. Do not call `readImportedField`, `readAuthoredField`, `contextSnapshot`, or an internal
body object as a substitute for that route's authorization and final disclosure checks.

`document.get` currently applies `subject:read`, candidate disclosure, imported source fences,
body validation and final identity/security checks. The aggregate adds property selection
binding; it does not grant any of those permissions itself. No anonymous substitution,
publisher privilege, internal allow header or permission cache is admitted.

### Exact response binding

On a native 200, check the public response envelope and require all of:

| Response value         | Must equal                           |
| ---------------------- | ------------------------------------ |
| `document.id`          | selected reference document ID       |
| `document.subjectId`   | effective survivor subject, exactly  |
| `document.candidateId` | selected statement ID                |
| `document.revision`    | selected `candidateRevision`         |
| `document.language`    | selected reference language, exactly |
| `document.digest`      | selected reference digest, exactly   |

Do not follow a document redirect or rewrite a foreign body to the current subject after a
merge. A valid document for another candidate, subject, language or digest is unavailable for
this descriptor even when the caller can read it independently. A missing linkage never falls
back to `content.document` in the subject statement. Subject statements remain references.

For an available document, require the actual validated `document.body` snapshot.
Keep imported `source` and `rights`, or authored `origin`, `author` and `licence`, exactly as
the public route supplies them. Do not turn an author UUID into a fabricated public name or
silently substitute the site's licence. Use existing page Sources presentation for attribution;
if identity labels are absent, do not issue a per-document author request.

For an imported erased document, retain only its route-authorized metadata and `body:null`.
Authored erasure is deliberately different: the route returns 404, concealing the tombstone.
The aggregate must preserve that distinction without manufacturing an authored erased DTO.

The proposed successful aggregate value is a closed wrapper:

```ts
type DocumentBinding = DocumentSelection & {
  documentRevision: number;
};
type BoundDocumentResult = {
  binding: DocumentBinding;
  document: PublicDocument; // Actual public document.get DTO; never internal DocumentView.
};
```

`PublicDocument` is a proposed exported name for the existing route response union, not a new
producer. Either export/reuse its public schema or infer it from the route in Kernel/client;
the portable composition package contains the binding and selector, not Content's full schema.
Do not expose bodies through generic `any` without runtime validation at the receiving boundary.

### Complete document request and result

This future HTTP request has one subject target and the existing language field:

```http
POST /v1/pages:read
Content-Type: application/json
Authorization: Bearer <the current reader token, when present>
rezics-session-token: <the genuine current reader session, when present>

{
  "target": { "subject": "00000000-0000-8000-8000-000000000010" },
  "languages": ["en"]
}
```

Use the actual `SESSION_HEADER` constant when implementing; the spelling in concrete capture
must remain `rezics-session-token`. Angle-bracket tokens above are notation, not minted credentials.
The compact example below supplies every field of the new document result; the ordinary
subject result still has its native complete DTO, rather than a copied body extension.

```json
{
  "status": 200,
  "body": {
    "binding": {
      "subject": "00000000-0000-8000-8000-000000000010",
      "context": "00000000-0000-8000-8000-000000000000",
      "property": "schema:recipeInstructions",
      "candidate": "00000000-0000-8000-8000-000000000020",
      "candidateRevision": 4,
      "document": "00000000-0000-8000-8000-000000000030",
      "language": "en",
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "rank": "preferred",
      "documentRevision": 4
    },
    "document": {
      "id": "00000000-0000-8000-8000-000000000030",
      "subjectId": "00000000-0000-8000-8000-000000000010",
      "candidateId": "00000000-0000-8000-8000-000000000020",
      "revision": 4,
      "origin": "account",
      "author": "00000000-0000-8000-8000-000000000040",
      "licence": "CC-BY-4.0",
      "language": "en",
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "availability": "available",
      "body": {
        "version": "rezics-document-v1",
        "profile": "text",
        "doc": {
          "type": "doc",
          "content": [
            {
              "type": "paragraph",
              "attrs": { "id": "step-1" },
              "content": [{ "type": "text", "text": "Simmer for twenty-five minutes." }]
            }
          ]
        }
      }
    }
  }
}
```

The enclosing page retains `subject`, `profile`, `template`, composition `document`, optional
`views`, and `reads`. In the minimal composition containing only that node, planning creates
`r0` for the subject and `r1` for this result; `nodes.method === 'r1'`. The composition document
and Content snapshot are separate fields with different contracts and size limits.
Global requests retain the existing top-level response shape; no mandatory `context` addition.

### Missing and failed bodies

| Observation                                  | Document read result and page behavior                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| No eligible selected reference               | 200 `{binding:null,document:null}`; omit body and instructions; Details may show an unresolved fact       |
| Public route 404                             | Preserve its 404 problem; no binding, body, ID, rights or reason from the selected-but-withheld reference |
| Imported erased, exact binding               | 200 bound erased metadata with `body:null`; no prose or instructions                                      |
| Any linkage mismatch                         | 503 standard `dependency_unavailable` problem; discard body and binding; show section retry               |
| Invalid snapshot or oversized canonical body | Same 503 dependency problem, never truncate, partially render or switch candidate                         |
| Standalone 401                               | Preserve authentication failure and native challenge; fail the page's authenticated request               |
| Standalone 503                               | Preserve typed unavailable/deadline behavior; section retry, no stale body                                |
| Unexpected thrown failure                    | Existing typed error handling; never catch all failures as empty or missing                               |

`{binding:null,document:null}` is a proposed empty variant of the closed wrapper above.
All other successful values require a non-null binding and document. Per-read problems use
the repository's actual RFC 9457 shape, not a fabricated success with an `error` string.
The enclosing page can succeed with a failed optional document section; authentication and
selected-page authority failures are whole-page failures. Retry is a new authorized page request.

### Final selection, replay and rollback

After dependent leaves, `guardPageSelection` reuses actual native `readSubject` with a freshly
prepared current `subject:read` check, selected Context and sticky public audience. This is a
proposed adapter around existing readers, not a new authorization helper. Compare selected
references, subject revision and resolution with the initial observation before serialization.
Record the guard's genuine session component. Do not rehydrate related labels just to compare
bindings, and do not perform a second routing subject GET.

Run one guard per distinct effective subject/Context, shared by all its document descriptors.
It retains the native anchored-subject costs: at most 512 descriptive facts, 64 relation
properties, 13 examined preview positions per relation property and 256 related-ID display
fills where the native reader needs them. Avoid the HTTP route's additional related-label
hydration, but do not remove native cover-summary or Access work from capture. No claim that
the guard costs one SQL point follows from its one subject descriptor slot.

The actual signature is `readSubject(pool,id,authorize,context,routeKey,summariesOptions)`.
Supply the current deadline, observed session and native authorization refresh callbacks;
calling `readSubject(...,async()=>true)` or `contextSnapshot` is prohibited here. Context
authorization and lifecycle checks belong to the selected-page adapter as well as subject Access.
This avoids assuming that `readSubject`'s internal Context lookup is public authorization.

If the subject is concealed, return the standard whole-page 404. If the subject revision or
selection changed but remains readable, discard all old bound results and return standard 503
`dependency_unavailable` with `Retry-After: 1`. Do not add an in-request retry budget, replan,
fetch a replacement candidate or emit a stale 200. The next request starts from current facts.
This conservative restart may also reject an unrelated subject edit; that costs availability
for a bounded comparison and prevents mixed revisions without inventing a Context selection epoch.

Content's current final fence/reference/disclosure passes remain the body read's consistency
boundary. A mutation committed before those passes must be observed according to that contract.
This proposal does not claim an atomic distributed snapshot or prevent a mutation after all
final authorization points. Tests pause at actual native observation seams, not arbitrary wall time.

All work is read-only. Native readers roll back failed snapshots and release connections through
their existing helpers. Aggregate failure drops request-local buffers; it writes no selection,
body, permission, retry ledger or outbox. Repeating a request performs current checks again;
there is no cached successful permission or stored stale body to replay after erasure.

### Cost

- Touches: admitted subject dependencies, one standalone `document.get` for each selected unique body, public route validation and final native selected-subject guard; include Content source-fence and Access homes and every observed session anchor.
- Bound: one dependency phase and one dependent round, at most four concurrent dispatches, 16 distinct logical reads and 128 slots across the request including probes/dependencies. Each body is at most 2,097,152 canonical bytes (`MAX_DOCUMENT_BYTES`); ordinary imported summaries also retain their stricter 32,768-byte admission cap. With one shared subject, at most 15 bodies reserve at most 31,457,280 canonical body bytes. This is a derived upper bound, not a raised response or wire allowance; metadata, JSON framing and native reader work retain their own owner bounds.
- Growth check: at 64, 512 and 4096 unrelated subjects, document rows, source fences and revisions, execute fixed 1-body and 15-body plans through real routes; record all dispatches, dependency phases, Access points/homes, source-fence probes, rows examined/removed, blocks, statements, connection peak, canonical body bytes and actual response bytes. Include success, missing, mismatch and changed-selection final guards; output length alone is not evidence.

## Rendering and instructions operation

Prepare one `BoundDocumentResult` per effective descriptor in `PageData`. Validate its binding
against the page's public subject and the shared selector before making it presentable.
`readableDocument` can validate a snapshot; it cannot prove permission or linkage. A snapshot
that passes `checkDocument` but arrived through an internal object is never sufficient.

The generic `Document` data component renders the available validated snapshot using
`DocumentValue` and its language tag. `Statements`, `MoreStatements` and About consume the same
prepared values for document properties instead of inspecting a string reference as a body.
When a property is explicitly rendered by `Document`, suppress its duplicate generic value in
`MoreStatements`, just as `shownProperties` currently handles explicit statement properties.
There is no branch on `schema:Recipe` in the renderer. The Recipe template configures the node.

The existing `Summary` node must also consume the property-bound aggregate for
`schema:abstract`; retain its public component props and About order. Its planned callback
becomes the corresponding document read with the same implicit subject dependency. Do not
keep an inline-body success path that lets Summary and instructions disagree on custody.
Fallback to the short public description remains the subject-page rule when no summary exists.

The Recipe serializer receives the prepared document map keyed by property and binding,
alongside the same public subject already used for other factual metadata. Its implementation
remains with Web's existing serializer assignment. It may project the selected body through
`documentText` for schema.org Text instructions; it must not parse arbitrary rich text into
invented ordered `HowToStep` claims. Existing separately adopted step handling, if any, must
consume this same binding rather than another body source.

For the complete body example above the instruction value is exactly:

```json
{ "recipeInstructions": "Simmer for twenty-five minutes." }
```

Use `serializeJsonLd` for script escaping. Hostile text remains text in both HTML and JSON-LD.
Extension payloads never execute and their text projection follows `@rezics/document`.
Do not resolve mentions or arbitrary URLs with extra network reads. Rendered spoiler controls
retain existing behavior; instruction text must not expose a hidden spoiler mark. For this
slice, a body containing a spoiler mark is rendered under existing controls but omitted as
a whole from machine instructions, avoiding a second lossy projection policy.

Absent, erased, withheld, failed or unbound bodies contribute no instruction field. Keep
the serializer's separate diet and cook-time work: the released vegetarian Concept and 25-minute
quantity yield their existing schema.org representation, including `PT25M`. This proposal neither
adds Recipe properties nor declares those serializers implemented or their native scenario green.

SSR on Cloudflare Workers must render prose and JSON-LD from the same aggregate response
before browser JavaScript. Kernel-side Content readers may use Node primitives; none of those
imports cross into the composition package or Web's Workers render graph. The portable selector
uses ordinary JSON, strings and existing composition utilities only.

Preserve `private, no-store` from `document.get` through `pages.read`, server functions,
HTML, deferred/hydration payloads and error responses. A public candidate audience does not make
a bearer-bearing response publicly cacheable. Keep caller-specific protected Realm/thread data
out of shared React Query keys and public cache namespaces. Existing immutable profile/definition
configuration caches may remain; page results, rights and permissions are request-local.

### Cost

- Touches: one owned aggregate result per descriptor, portable snapshot validation, the existing DocumentBody renderer, text projection and JSON-LD escaping; no fetch, permission check or identity hydration from a card.
- Bound: process each admitted body once for preparation and once per required projection, linear in its at-most-2,097,152 canonical bytes; reuse prepared values for repeated nodes. Combined canonical body input is bounded by the admitted document plan, at most 31,457,280 bytes with one subject. No composition-byte limit is misreported as a response-byte limit, and no page byte cap is increased.
- Growth check: native workerd SSR with 1, 8 and 15 bodies, tiny and maximum admitted authored bodies, and maximum imported summaries; record aggregate requests, body projection counts, wire bytes and actual Workers resource observations. At fixed plan and bytes, unrelated owner populations must not add requests or rendering work; preserve the existing one non-agent routing GET ceiling.

## Context binding operation

Adopt the existing [Realm request and response contract](subject-pages.md#realm-context)
at the actual `pages.read` target parser and response schema. The current implementation accepts
subject, route or account and optional view; it does not yet accept the specified Realm selector.
Do not present this specification's proposed bindings as an already callable Realm page route.

```json
{
  "target": {
    "subject": "00000000-0000-8000-8000-000000000010",
    "realm": "00000000-0000-8000-8000-000000000050",
    "view": "discussion"
  },
  "languages": ["en"]
}
```

The authority sequence is the existing one: actual `readRealm`, actual `readPublication`,
independent native Context authority and current subject disclosure. Keep the caller Actor,
bearer, native Auth/Access time, deadline and session. A publication pointer is not a permission.
Use the delivered sticky public statement reader for probes and leaves, including the document
selector's subject input. Private standalone hydration remains independently authorized.

Represent the selection internally once:

```ts
type SelectedPage = {
  subject: string;
  context: string;
  population: { kind: 'global' } | { kind: 'realm'; id: string; title: string };
  // Server-only current Realm/publication observations, not client permission tokens.
};
```

The public optional `context` response remains exactly the adopted subject-page shape:

```json
{
  "context": {
    "id": "00000000-0000-8000-8000-000000000060",
    "population": {
      "kind": "realm",
      "id": "00000000-0000-8000-8000-000000000050",
      "title": "Kitchen readers"
    }
  }
}
```

`subject.context`, subject/links/document effective descriptors and binding Context all equal
the selected Context ID. Thread place is deliberately different: it equals Realm ID for a
Realm population, and `GLOBAL_CONTEXT` for Global. Never pass a community Context UUID as
the thread place merely because both are routable UUIDs.

If the readable Realm has a genuine null publication, independently authorize Global and
return exactly `{id:GLOBAL_CONTEXT,population:{kind:'global'}}`, with no Realm title, ID or
fallback reason. Unknown or denied Realm, protected ban or thrown `not_found` conceals the
whole page; it cannot become a Global success. A Context denial/deletion also conceals.
Agents retain canonical Global address behavior; account and route targets reject Realm.

After selected leaves, re-read current Realm Context/head, publication and protected-ban
authority as required by the owner contract. Changes to publication can occur with an
unchanged Realm head. This proposal chooses 503 `dependency_unavailable`, no `reads` or
selected metadata, with `Retry-After: 1` after withdrawal/rejection or a Context/head change.
Late ban returns standard 404. A subsequent healthy request resolves the current Global
fallback or new Context. No second dependent round, in-request fallback rebuild or new retry
allowance is introduced. Thread and document leaves are discarded with the old selection.

The actual Context lifecycle routes now include delete/restore in `semantic/http/contexts.ts`;
use their current declarations and native acceptance instead of the older receipt's missing-route
description. This is source binding, not an independent verification of that owner's receipt.
Do not edit the frozen Realm acceptance or add a substitute Context deletion operation.

### Cost

- Touches: native Realm, publication and Context authority at their homes, current subject, the final selected-subject guard and the final Realm/publication/ban guard; each remains under actual Access and the request session.
- Bound: fixed anchored control reads with existing native owner/deadline bounds, no Realm enumeration or history sweep, no extra retry. Controls are charged as actual dependency/authorization work; they do not create 16 new read allowances or 128 authority slots. Subject/links/documents/threads still share one 16-read/128-slot plan and four dispatch workers.
- Growth check: retain existing native Realm race scenarios and grow unrelated Realms, publications, Contexts and revisions at 64, 512 and 4096. Capture initial and final points, every pool's rows/statements/blocks and denied/fallback costs; a head-only guard or uncharged late authority work fails.

## Subject-thread traversal operation

Bind `ThreadList` to a closed `subjectThreads` descriptor. Keep its existing `paged` prop;
the overview's current configured preview ceiling is five. No browser-selected place or Context
is persisted in a template. A null subject plans no thread read.

```ts
type SubjectThreadsRead = {
  kind: 'subjectThreads';
  id: string;
  place: string; // Resolved Global Context or selected Realm, never editorial Context.
  threadKind: 'discussion' | 'review';
  limit: number; // Native 1..20; ThreadList preview is 5.
  cursor?: string; // Only bound continuation, absent on a preview.
};
```

This descriptor invokes the actual standalone operation, with unchanged credentials:

```http
GET /v1/subjects/00000000-0000-8000-8000-000000000010/threads?place=00000000-0000-8000-8000-000000000050&kind=discussion&limit=5
```

The callable operation ID is `subject_threads.list`. `listSubjectThreads` returns
`entries`, `nextCursor` and anchors internally. The HTTP DTO is `{threads:[...],next:string|null}`;
return it unchanged as the aggregate read body. Do not invent `total`, `count` or `hasMore`.
Each `threads` element is the actual Content `ThreadView`, with current title/removal and
disclosed opening-post data. Rendering consumes it as delivered; it does not fetch every thread.

The actual route orders by latest activity with the native stable ID tie-breaker. The title
and label must describe that order. `ThreadList` thereby satisfies active discussion. Review
descriptors can use this native activity order in an explicitly labelled full Reviews view;
this proposal does not call activity order “most helpful” or implement a new helpful-review rank.
The existing overview helpful-review and rating-population obligations remain with their owners.
No Realm figures or Realm review ranking is inferred from a selected factual Context.

`readCost(subjectThreads)` is its requested limit, including continuation. The descriptor is
canonicalized with subject, place, kind, limit and cursor; discussion and review never alias.
Changing current Realm Context does not change the native place ID, so the aggregate's
separate selection guard is still required before publishing that result.

An empty native page with `next` is a real scanned page, not the end of the discussion.
Render a server continuation link and an honest “no visible entries on this page” state.
Do not auto-drain the cursor, claim “no discussions”, or run another leaf to fill it. This is
Content's bounded thread traversal, not a redefinition of filled catalogue query semantics.
With `next:null`, show the existing invitation when the read is open and empty.

Content already scans at most `4 * limit` indexed candidates and hydrates only within that
window, checking current subject, thread, opening post, board, Realm and placement. An index
candidate is never an authorization certificate. A stale board place, denied protected Realm,
removed post or hidden thread keeps its native concealment/removed behavior.
No aggregate authority override can resurrect one.

### Cost

- Touches: the exact subject/place/kind index range, native subject Access, at most the native candidate window and each candidate's existing thread/post/board/Realm disclosure; retain all native anchors.
- Bound: limit 1–20, preview 5, at most 4L candidates (20 at preview, 80 at full native maximum) per descriptor, no refill loop or offset. Duplicates share one dispatch and one L cost. Across admitted distinct thread reads, requested slots sum to at most 128 and candidate windows sum to at most 512, with at most 16 descriptors; their native disclosure costs remain additional measured work.
- Growth check: place 1, 10 and 100 threads behind one subject and repeat at 64, 512 and 4096 unrelated subjects/boards, including hidden windows and late board loss. Record candidates scanned, hydrated items, all authority points, rows/statements/blocks, cursor advancement and actual bytes; prove at most 20 preview candidates regardless of total history.

## Composed continuation operation

Retain existing standalone relation, edition, credit, claims and history APIs. Extend `pages.read`
with one optional closed top-level continuation, so SSR can continue a configured node while
re-resolving current page authority. Do not add an arbitrary client-authored descriptor array.

```ts
type PageContinuation = {
  node: string; // Existing composition props.id, same safe ID grammar.
  cursor: string; // Opaque native cursor, validated by its owning route.
};
```

Complete future request:

```json
{
  "target": {
    "subject": "00000000-0000-8000-8000-000000000010",
    "realm": "00000000-0000-8000-8000-000000000050",
    "view": "discussion"
  },
  "languages": ["en"],
  "continuation": { "node": "discussion", "cursor": "opaque-native-token" }
}
```

The target must name a defined full view and a current `paged:true` node supporting native
continuation. Reject route/account targets for this subject continuation variant; do not break
their existing independent account continuation links. Unknown node, nonpaged node, multiple
continuations, unknown fields and non-string cursor are validation errors at their exact
`/continuation/...` pointer. Never search another template or accept a client Context override.

Resolve Realm, publication, Context, survivor and current template first. Bind the continuation
to that template's exact descriptor, replacing its first-page read rather than adding a second
read. Preserve all other reads and include the replaced read's cost once. The same node-to-key
mapping is used by Kernel and Web. Cursor substitution must precede effective canonical dedup.

For inverse links add the native cursor field to the internal links variant and dispatch its
existing query parameter. Forward relation pages continue through their actual `subject.relations`
operation with selected Context, property and filters; do not misuse inverse links for forward
relations. Explicit continuation adapters must preserve direction, qualifier and native sort.
Use the closed variant specified below; no general graph walk or multi-property merged cursor
is admitted by this proposal.

For editions, contents, appearances and credits use the existing configured relation component
and native direction. A section containing several relation properties has a separate See all
link per property. One cursor belongs to one native ordered stream, not a union synthesized in
Web. Details continues candidate claims and subject revisions through their existing routes;
it may link to those separately authorized server views rather than adding body/history leaves
to the overview aggregate. Retain provenance, qualifiers, credit positions and spoiler gates.

Thread cursors already bind subject, place, kind, viewer and partition epoch. Links/relations
retain their current native Context/filter/order binding. The aggregate may not decode, sign,
rewrite or manufacture these cursors. A cursor rejected by its owning standalone route retains
that typed failure. A changed Realm selection or profile that makes the node disappear produces
an explicit restart state/link without replaying the old Context or silently using its old body.

No new signed page continuation token is needed. Native cursor validation bounds token size;
Content's `SubjectThreadsQuerySchema` admits 1–4,096 characters. Web must accept that actual
bound rather than its current 2,048-character loader check. Semantic's HTTP page query has no
declared cursor `maxLength`; retain its actual codec/body admission instead of claiming the
Content ceiling applies to every native cursor. This proposal raises no native cursor capacity.

SSR URLs preserve locale, subject/Realm routing, view, node and encoded cursor. A new request
always resolves current authority; a browser back/forward cache or loader cache cannot certify
an old selection. “Start again” drops only the cursor and reuses the current target and view.
After error, a healthy first-page request must recover; no permanent preparing placeholder.
Do not follow all pages during one SSR or fetch per returned card.

### Cost

- Touches: the same current page selection and planned node, one opaque native continuation, the actual existing list route and final selection guards; no traversal of a prior page's bodies or history.
- Bound: one continued node per request replaces one preview; at most 16 distinct reads and 128 slots, native registry list limits unchanged (links up to 24 here, threads up to 20), four workers, one dependent round and zero automatic cursor drains. Every new user page is a separately admitted bounded request.
- Growth check: traverse 53 eligible entries with native page limits 5 and 20, hidden candidate windows and equal sort keys; record each page's candidates, bytes and requests. Grow unrelated relation/thread histories at 64, 512 and 4096, then revoke board access and change Context between pages; no duplicate, skipped stable eligible item, stale authorization or unlimited per-request drain is allowed.

## Forward relation binding operation

The proposed internal forward descriptor is fully separate from inverse `links`:

```ts
type ForwardRelationsRead = {
  kind: 'relations';
  id: string;
  property: string;
  context?: string;
  filter?: string;
  type?: string;
  limit: number;
  cursor?: string;
};
```

Use existing safe UUID/CURIE schemas, closed fields and optional cursor handling. Its component
callback is `readDirected` for an explicitly forward `Appearances` or `Credits` node; change
that branch from the subject-only display preview to this native forward read, using the
node's property/filter/type/limit. An inverse node retains `links`. A page's existing subject
header/dependency is still planned once. `readCost(relations)` equals its requested limit.
Keep registry limits 1–24 rather than expanding to the native route's 1–100 limit.

Example native input for a first page and its sole continuation difference:

```http
GET /v1/subjects/00000000-0000-8000-8000-000000000010/relations?property=schema%3Aauthor&context=00000000-0000-8000-8000-000000000060&limit=12
GET /v1/subjects/00000000-0000-8000-8000-000000000010/relations?property=schema%3Aauthor&context=00000000-0000-8000-8000-000000000060&limit=12&cursor=opaque-native-token
```

Build URLs with `URLSearchParams`, preserving native encoding and grammar. The aggregate body
is the actual `subject.relations` DTO: `relations` entries containing native `statement`,
`target`, `external`, optional `type`/`label`, and nullable `summary`; native `count`,
`freshness` and `next` remain unchanged. The adapter must not reduce a qualified statement
to a target label or invent public count semantics of its own. Native route errors retain
their per-read status/body. Current selected-page denial still conceals the whole response.

Kernel and Web planners must agree on the new forward branch for first and continued pages.
The consumer groups returned native statements by their existing semantic role while preserving
order/qualifiers; `next` links name the originating node/property. The result cannot be merged
with another property's stream. Both whole briefs include this union/cost/dispatcher/client
closure where they touch the common planner; the traversal brief owns its native tests.

### Cost

- Touches: one native outbound subject/Context/property/filter range, its counter and selected slot views, bounded target summaries/labels and current Access; no global graph or history enumeration.
- Bound: at L≤24, at most L+1=25 outbound positions without a type filter, or 4L+1=97 with one, plus the native at-most-1,000 type-count candidates. Each returned target's original-language slot uses at most 33 compact fact rows or 32 expanded selections under the existing Semantic contract. These costs are charged per distinct relation descriptor within the same 16-read/128-slot aggregate; native authorization is additional measured work.
- Growth check: at fixed L=12 and L=24, use 64, 512 and 4096 relations and unrelated histories, with and without type filters and a selected Context overlay. Capture actual range/count rows, slot/label/Access work, statements, blocks and bytes; stable qualified relation traversal and current concealment must hold beyond the first 12 entries.

## Frozen document acceptance scenarios

These cases are frozen future native acceptance specifications inside this artifact. They must
be implemented as real tests by the whole brief below. They are not tests executed in this
documentation attempt. Never weaken existing frozen suites or turn missing ports into skips,
permanent throws, mock permission, fake executable exports or a green serializer-only result.

Use the existing native Semantic driver, composed Kernel, real Auth/Access and ordinary
licensed document contribution/import hooks. Read actual producer-returned IDs, revisions,
digests and session anchors. No direct database body insert may supply product fixture behavior.
Database capture is observation only; no monkey-patched route returns its expected response.

### Available body and shared representation

```text
Given a public Recipe with an adopted preferred English instructions candidate,
  a normal English alternative, normal Japanese alternative, public vegetarian Concept,
  and a disclosed 25-minute cook time, all produced through ordinary native routes;
When anonymous loads its configured overview through actual pages.read;
Then the plan contains one subject dependency and one document descriptor for instructions,
  document.get receives the selected preferred candidate's document UUID exactly once,
  its response's subject/candidate/revision/language/digest equal the selected reference,
  and the aggregate returns that available validated body and its exact authored rights;
And actual workerd HTTP HTML before JavaScript contains its method text and language,
  recipeInstructions contains documentText of that same bound body,
  cookTime is PT25M and diet remains the serializer's adopted public representation;
And neither alternative's canary text appears in HTML, hydration or JSON-LD.
```

Repeat generic document composition on an existing Book document property to prove the renderer
and executor do not branch on Recipe. Diet/time assertions belong to the serializer's existing
native case as well; this fixture reuses it rather than weakening or replacing that case.

### Language, rank and aliases

```text
Given two preferred English candidates with different statement IDs and one normal Japanese;
When the request starts with Japanese and both preferred English candidates remain public;
Then rank-first chooses preferred English and the lowest statement ID within that language;
And repeated Document nodes for the property and Summary aliases share their effective leaf;
When a private publisher-only candidate would otherwise win;
Then editor and anonymous aggregates select from public candidates only, with unchanged caller;
And the editor's independently authorized standalone private subject read keeps its own semantics.
```

### Linkage discrimination

```text
For each separately readable body with a foreign subject, candidate, revision, language or digest,
  arrange a native reference/fixture at the owner's supported test seam that exposes the mismatch;
When the selected descriptor executes the real document route;
Then its available body is discarded, the read is typed dependency_unavailable,
  and no foreign text, body metadata, binding, identifier or instructions reaches Web;
And no alternative candidate/body request follows it in this aggregate.
```

A fixture seam may arrange corrupt data in an isolated native database only for invariant
failure cases that ordinary product commands correctly refuse. It must not replace the public
route or fake an authorization answer. Record that corruption control separately from ordinary
producer cases. Keep actual native document route malformed-body checks intact.

### Concealment, erasure and changed selection

```text
Given available authored and imported bodies whose native document controls succeed;
When the candidate is hidden, taken down, private, or its imported source fence is taken down;
Then current document.get concealment wins even with an old selected reference and genuine session;
And the aggregate returns no selected binding or body-derived field for that concealed leaf.
When an authored body is erased through DELETE with the author's genuine authority;
Then repeat and aggregate reads conceal it as 404, without an authored tombstone DTO.
When an imported body has the native erased representation while still disclosable;
Then the aggregate preserves exact erased metadata and null body, with no instructions.
When selected candidate A is replaced by B after the initial public dependency and before
  the final selected-subject guard, even if A remains independently document-readable;
Then no A/B mixture is serialized: the page is retryable 503 with no reads/body/context payload;
And a later healthy request selects B under current authority without an extra retry allowance.
```

### Invalid body, failure and cache custody

```text
Given native malformed, noncanonical, oversized and invalid-UTF-8 body controls;
Then the Content route retains its existing concealment/validation behavior;
And an invalid available body at the aggregate receiving boundary is dependency_unavailable,
  never truncated HTML, an inline reference fallback or a replacement-candidate fetch.
When native document.get is unavailable or the deadline expires;
Then the section has a truthful retry state, JSON-LD omits instructions and no stale body is used.
When an account uses a genuine pre-suspension bearer after native suspension;
Then the standard authentication failure and Bearer challenge survive; no body is serialized.
When Alice warms an authorized page and anonymous or Bob requests its URL afterward;
Then their own real authority executes and no Alice-specific body or thread data appears;
And route, aggregate, HTML, hydration and errors remain private, no-store.
```

### Admission and native byte boundaries

```text
Given a composition with 15 distinct document properties and one shared subject dependency;
Then expanded reads equal 16, document costs equal 15 and total cost equals 16;
When one more distinct property is configured;
Then publication and execution refuse the 17-read expanded plan before document dispatch.
Given aliased descriptors, unknown fields, accessors, cycles and malformed binding props;
Then validation occurs before dedup, with sorted escaped pointers and zero body dispatch.
Given accepted authored bodies at the native 2,097,152-byte ceiling and rejected bodies above it,
  and imported summaries at 32,768 bytes with native above-limit rejection;
Then the actual native producer/reader bounds remain unchanged and aggregate counters include bytes.
```

Construct exact-size fixtures from canonical serialized producer input, not string length.
Measure UTF-8 bytes using the existing canonical serialization; do not add a new hash receipt.
Observe the original raw-descriptor alias ceiling of 16 at executor input separately from
the expanded distinct-read ceiling. A 128-slot plan passes; 129 slots fail before leaf dispatch.
Use existing list reads to fill slots; do not assign artificial costs to documents.

## Frozen context and traversal acceptance scenarios

Reuse the existing frozen
[Realm acceptance](../services/kernel/test/presentation/realm-context-user-cases.test.ts)
and [aggregate authority acceptance](../services/kernel/test/presentation/aggregate-authority-user-cases.test.ts)
unchanged. Their real A/B, Global inheritance, protected ban, publication withdrawal/rejection,
suspension and lifecycle cases are mandatory regressions, not scenarios to reimplement with mocks.
The following cases add the missing composed document/thread and continuation discrimination.

### One selected Context across the page

```text
Given public work/edition/credit fixtures with Global author and method A,
  Context A replacing the method and suppressing the Global edition relation,
  Context B inheriting editions but selecting a different method,
  and a readable published protected Realm currently selecting A;
When its authorized member requests pages.read overview;
Then subject.context, links context and document binding context are all A,
  the method is A's exact selected candidate and no suppressed Global edition appears;
And discussion's place is the Realm ID, not A's editorial Context ID;
And every native subread keeps the same caller and genuine merged session.
When the Realm changes to B before final guards;
Then stale A cannot succeed, and a subsequent healthy request returns B and inherited editions.
```

### Global fallback and late authority

```text
Given a readable Realm with no current publication and an independently readable Global subject;
Then selected facts/method/relations/discussion are Global and metadata has only the Global label;
And no Realm ID, title, unpublished reason or protected thread canary is emitted.
Given a published Realm and successful selected subject/document/thread leaves;
When publication is withdrawn or rejected while Realm Context/head remain unchanged;
Then final guards return retryable 503 with no selected output, followed by healthy Global fallback.
When a protected ban commits at the same native barrier despite an independent read grant;
Then return standard whole-page 404 without fallback, bindings or old thread metadata.
When subject or selected Context is deleted/concealed at the native lifecycle boundary;
Then current authority wins and old document/thread sessions cannot revive it.
```

### Complete discussion traversal and current board loss

```text
Given 53 stable eligible discussion threads in one selected place with equal activity ties,
  plus other-place, hidden, draft and removed-opening-post controls;
When the reader follows every server-rendered continuation through pages.read;
Then each eligible stable native thread appears once in native order,
  removed slots retain native null title/body behavior and no other-place canary appears;
And each response contains the actual native next token or null, never a fabricated count;
And there is one descriptor aggregate per page with no card GET/document hydration.
When a window contains only concealed candidates but native next is non-null;
Then SSR offers the next page without claiming the complete list is empty or auto-draining.
When board/Realm authority is lost between pages or before a candidate's final disclosure;
Then the next native result conceals it and cached previews cannot restore it.
```

### Native cursor and node binding

```text
Given a genuine cursor for subject S, place P, kind discussion and Alice;
When Bob, another subject/place/kind, an invalid epoch or a tampered token reuses it;
Then the actual standalone typed cursor outcome is retained, without changing its binding.
When a continuation names an unknown/nonpaged node, a document node, or several nodes;
Then pages.read refuses at the continuation pointer before leaf dispatch.
When activation changes the template so the continued node no longer exists;
Then SSR offers a current first-page restart and never replays an old template's descriptor.
When a new first-page request follows any rejection with current authority;
Then it succeeds or returns its truthful current owner state, never permanent preparing.
```

### Relations, claims and no-JavaScript closure

```text
Given more than a preview of editions, ordered contents, cast/crew and inverse credits,
  with position, credited name, character, source references and spoiler qualifiers;
Then native relation continuations preserve those meanings through the selected Context;
And every stable eligible relation is reachable once, without a merged multi-property cursor.
Given competing sourced date claims and revision history;
Then Details links to the actual native claims/history pages and can continue beyond its preview;
And unresolved claims do not become adopted document bodies or JSON-LD assertions.
When actual workerd HTTP is fetched with JavaScript unavailable;
Then visible method, Context label, discussion/relations continuation and Details links are usable;
And aggregate-derived metadata uses only the displayed public binding before hydration.
```

Keep the existing Web publication traversal and Recipe case titles intact. Additional cases
may use their native fixture builder and genuine issued credentials; they must not count a fake
upstream serializer fixture or ordinary `renderToString` as native Workers proof.

## Whole implementation brief: document descriptor and aggregate binding

This brief is one coherent implementation, estimated 1,100 changed lines across composition,
Kernel presentation, generated client closure, Web preparation and native tests. It consumes
the existing Content route and ordinary document hooks. It does not wait for a new producer,
Recipe vocabulary, unrelated Search indexing closure or a repeated research round.
Overlap with the existing Recipe serializer assignment is coordinated at `jsonld.ts`; it is
not an unnecessary `after` edge. The only required interface is this adopted bound-body input.

### Deliverable and path closure

Implement the complete property-bound document operation above, its shared selector, all
admission/failure cases and the real prose/metadata/Workers consumer. Expected paths are:

- `packages/composition/src/registry.ts`, `reads.ts`, `index.ts` and a small selector module.
- Composition schema generator output, registry/read/selector tests and owning README additions.
- `services/kernel/src/presentation/reads.ts`, `http/pages.ts`, `http/page-contract.ts`.
- A focused presentation document binding module for pure response checks and final adapter.
- The Content public DTO export only if necessary; do not change its authorization or producer.
- `packages/composition/profiles/platform.json` and released presentation configuration only
  where Summary and the generic Recipe Document node must be wired; no datatype/schema change.
- `apps/web/src/features/pages/values.tsx`, `data.tsx`, `overview.tsx`, `subject.tsx`,
  `subject-head.ts`, `layout.tsx`, `editor-config.ts` and `jsonld.ts` at their actual call sites.
- `packages/client/src/kernel/**` and OpenAPI artifacts generated by the owning commands.
- New native presentation document/growth tests, focused Web binding tests and a Workers host case.

Read compatibility has to close the whole graph: registry -> generated composition schema ->
publish validation -> profile planner -> routing probe -> aggregate dependency scheduler ->
public Content route -> binding validation -> final guard -> common response -> generated
client -> loader/pageContext -> PageData -> renderer and subjectHead/JSON-LD -> Workers SSR.
Leaving any of these consumers on inline bodies is incomplete, even if a pure selector test passes.

### Implementation sequence

1. Freeze the document cases above in new real native files with actual fixtures and assertions.
   Preserve every existing acceptance file. Do not introduce imports of non-existent helpers.
2. Add the closed component, union, cost, implicit dependency planning and shared selector.
   Keep portable imports; update registry schema through its generator, never handwritten JSON.
3. Carry effective Context and language selection through both planner and executor variants.
   Normalize before dedup and preserve existing raw input custody/error pointers.
4. Reuse probes and execute one dependent round through `document.get`, sharing four workers.
   Copy only the public route DTO and require exact selected linkage before retaining a body.
5. Add the final selected-subject adapter with actual authorization refresh, native Context
   authority, session observation and no additional retry round. Conceal or restart as specified.
6. Prepare one immutable bound value for prose and serializer input. Wire Summary and generic
   Document rendering and duplicate-property suppression. Keep About prose ordering unchanged.
7. Connect the existing Recipe serializer to the adopted bound input with its owner; leave
   diet/time serialization in that same coherent consumer, without another source fetch.
8. Close generated declarations, schema and fake/recorded fixture shapes. Fakes need realistic
   empty/failure/bound variants for component coverage but never serve as native privacy evidence.
9. Execute the native route, growth and actual workerd cases at integration. Record exact
   scenario counts, no skips/todos, native counters and revision; formatting alone proves none.

If a native reference proves a mismatch, fix the binding/consumer and rerun its affected
cases. Do not rewrite the oracle to accept inline snapshots, drop language selection, expose
unbound rights, or count internal `readDocument` success as public-route authorization.
Rollback is reverting the new configuration and binding code together; immutable old profiles
remain readable. No stored body or migration requires data rollback. A rejected request is safe
to replay as a new currently authorized read, without idempotency metadata or a durable retry job.

### Actual acceptance commands for later integration

Commands below use existing runners. Newly named test files are deliverables of this brief,
not files claimed to exist now. Run from the repository root after the implementation lands:

```sh
bun run --cwd packages/composition check
bun run --cwd services/kernel check test/presentation/document-page.test.ts test/presentation/growth-document-page.test.ts test/presentation/aggregate-read-admission.test.ts test/presentation/aggregate-authority-user-cases.test.ts test/presentation/page-languages.test.ts test/presentation/outcomes.test.ts
bun run --cwd apps/web test ./tests/pages-document-binding.test.ts ./tests/pages-jsonld.test.ts ./tests/pages-render.test.ts
bun run --cwd apps/web test:host
```

Extend the host runner's real discovery with the new document Workers file; preserve
`pages-workers.host.test.ts` and the native publication wrapper, including its existing Recipe
instructions/diet/PT25M case. `test:host` is an actual host runner, not a mock server assertion.
If selecting focused files, use the runner's current documented arguments rather than inventing
a green no-op command. No host, native or acceptance command is run for this specification slice.

Generated closure uses the actual package commands:

```sh
bun run --cwd services/kernel openapi
bun run --cwd services/kernel client
bun --cwd packages/composition scripts/schema.ts
bun scripts/typecheck.ts
```

Run generation in the assigned implementation worktree and include its real outputs. Inspect
the owning scripts before execution because Kernel construction may need its compiler database.
Do not manually widen generated response types, edit frozen tests, or write under node_modules.
Any dependency manifest change first requires the repository's private-install procedure.

### Completion evidence

The implementer hands off the exact current revision, new native case counts, unchanged
regression counts and raw captures for 64/512/4096 owner populations. Include document-route
dispatch identity, selected binding observations, guard points, byte sizes and Workers HTTP
HTML/JSON-LD correspondence. A genuine upstream digest is fixture data, not a new checksum receipt.
Product outcome remains unclaimed until these tests execute on the integrated implementation.

## Whole implementation brief: context and subject-thread traversal

This brief is one coherent implementation, estimated 1,350 changed lines across presentation
binding, native continuation, Web SSR and tests. It implements the already adopted Realm page
contract and the concrete thread/continuation proposals here. Existing Context lifecycle,
Community publication, Semantic relation and Content thread owners retain their APIs.
Do not wait for unrelated rating producers, mounted Zone completion, helpful-review ranking,
Search rebuilds or a second research task. Those remain separate obligations, not empty stubs.

### Deliverable and path closure

Expected changes include:

- `packages/composition/src/registry.ts`, `reads.ts` and exported internal page context types.
- `services/kernel/src/presentation/http/pages.ts`, `http/page-contract.ts`, `reads.ts` and
  a selected-page adapter carrying actual Realm/publication observations for final guards.
- Current native Context/read authorization bindings only where the aggregate needs a real
  adapter; preserve Semantic/Community permissions and lifecycle behavior.
- New subject-thread descriptor and bounded continuation adapters to existing Content and
  Semantic HTTP routes, with no new list storage/index or per-card hydration subsystem.
- Web `subject.tsx`, `subject-queries.ts`, `subject-frame.tsx`, `overview.tsx`, `data.tsx`,
  view links/tabs, route search parsing and server cache custody at the actual subject routes.
- Generated Kernel/client response closure and focused current recorded/fake page data.
- New composed context/thread/traversal native and growth tests plus actual Workers SSR cases.

The call-site closure is request validation -> actual selected-page authority -> Context-bearing
probe -> effective planner keys -> subject/links/document binding -> thread place -> single
continued node -> native dispatch/cursor validation -> final Realm/publication/ban/subject
guards -> response metadata/session -> client -> SSR URLs/sections -> next request's authority.
No raw Context query or old client-side selection may bypass any of those edges.

### Implementation sequence

1. Register the new frozen context/thread cases alongside existing real Realm/aggregate
   authority suites. Reuse their native driver and A/B fixture; do not invent a second world.
2. Extend only the specified subject target with Realm and the specified continuation body.
   Reuse current validation/pointers. Old Global request/response and agent redirects stay valid.
3. Bind actual Realm/publication/Context authority and genuine null-publication Global fallback.
   Keep denied/null/thrown-not-found distinctions; never turn a ban into a readable fallback.
4. Thread selected Context through subject and links descriptors, probes, keys and session.
   The document binding uses the same effective Context once its brief is present.
5. Add discussion's `subjectThreads` callback and native place binding with preview 5.
   Reuse actual HTTP `{threads,next}` without totals, anonymous fallback or card requests.
6. Bind one node continuation before dedup, with unchanged native cursor and native list limits.
   Retain relation directions and separate property streams. Details uses current native
   claims/revisions routes and server links instead of a new overview history aggregate.
7. Apply final actual Realm/publication/ban guards after successful selected leaves, including
   the unchanged-head withdrawal/rejection schedules. Late changes discard all selected output.
8. Carry optional Context/population and continued node through generated declarations and
   Web pageContext. Render retry, restart, empty-with-next, removed and denied states honestly.
9. Verify actual Workers responses before JavaScript, complete cursor walks and native counters.
   Record the precise remaining rating/helpful-review boundary without claiming it is fulfilled.

The document and traversal briefs can overlap in presentation files. Coordinate the shared
types and scheduler once; overlap is not a dependency edge. A combined context-document native
case requires both implementations to be present at integration, not a serialized dispatch of
unrelated work. Neither brief may substitute a runtime “not implemented” success or missing-port
throw for an actual path. Minimal outside-path repairs must remain within declared risk areas
and be listed with reasons in the implementation handoff.

Rollback drops the new caller/request wiring and configuration as a coherent change, leaving
native Contexts, publications, documents and thread indexes untouched. In-flight read failures
roll back native snapshots; they enqueue no repair. Replay starts a current authorized request.
Native cursors preserve their existing expiry/restart/error rules; no page cache extends them.

### Actual acceptance commands for later integration

```sh
bun run --cwd packages/composition check
bun run --cwd services/kernel check test/presentation/realm-context-user-cases.test.ts test/presentation/aggregate-authority-user-cases.test.ts test/presentation/context-thread-page.test.ts test/presentation/growth-context-thread-page.test.ts test/semantic/context-relations.test.ts test/semantic/relations-uncapped.test.ts test/semantic/subject-page-http.test.ts
bun run --cwd apps/web test ./tests/pages-context-traversal.test.ts ./tests/pages-data.test.ts ./tests/threads-read.test.ts
bun run --cwd apps/web test:host
```

`context-thread-page.test.ts`, `growth-context-thread-page.test.ts` and
`pages-context-traversal.test.ts` are new deliverables, with actual native fixture setup and
assertions covering every frozen case above. Retain the existing native publication wrapper's
edition/contents/cast/crew/inverse-credit/relation/claim journey cases. The original six page
outcomes, Realm authority cases and document brief's Workers cases also remain regressions.
Generate OpenAPI/client artifacts and run affected workspace typechecks through the same
actual commands named in the document brief; no duplicate generated-type authority is added.

### Native cost capture and recovery evidence

Fix the plan and grow owner populations geometrically at 64, 512 and 4096. Record the actual
initial/final Realm/publication/Context and Access work, per-leaf candidate reads, native cursor
advancement, rows examined/removed, blocks, statements and peak connections in every backend
pool. Include source-fence/document bytes when the composition has a document. Thread-only
growth must not be credited as document or complete native Access growth evidence.

Run success, genuine-null Global fallback, denied Realm, late ban, unchanged-head withdrawal,
unchanged-head rejection, changed Context, Context deletion, hidden subject and unavailable
owner paths. No uncharged final guard or background refill may hide outside capture. At fixed
plan and body sizes, population growth permits indexed logarithmic block growth under owning
contracts, not more descriptors, wider scans, extra rounds or cursor draining.

For traversal, use 53 stable eligible entries plus concealed controls, equal-key ties and
different places; retain each native token and actual request/response in order. Assert each
per-request bound separately and finite whole-user traversal. Recovery starts again with current
authority after a typed rejection; it is not a repeated stale selected-page replay.

## Specification handoff

This document selects the generic property-bound descriptor, public route custody, rank/language
rule, exact immutable linkage, single dependent round, charged implicit dependency, conservative
final-guard restart and native subject/place thread continuation. Each new cross-owner choice
remains a proposal pending adoption; existing cited owner authority remains effective.

The source reading for this design was the actual composition registry/planner and public
limits, presentation pages/executor/schema, Content document route/reader/byte validation,
public semantic statement and Context declarations, Content subject-thread reader/index route,
Web values/preparation/render/JSON-LD/loaders, and the existing Realm/publication/native
publication contracts. The reference-project index was read; no new external implementation
pattern or standard was required for this bounded closure of existing contracts.

Only this declared document is changed. No runtime producer, executable test module, frozen
test, generated artifact or risk-area implementation is changed by the specification attempt.
Its acceptance is document presence/completeness and formatting only. Native scenarios and
commands are instructions for the later whole implementations, with no runtime, native,
Workers, database, promotion or product-completion outcome asserted here.
