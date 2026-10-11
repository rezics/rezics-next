# Structured Work publication without prose notes

Read-only specification for Launch decision reference `de499`, inspected on
2026-10-11 at `902d8eac6afac082532e8b0f789b2ea36bedd9f9`. All source paths and
line numbers below refer to this worktree at that commit, not another worker's
unmerged changes. No product code or tests were changed or executed. Runtime
outcomes below are deductions from inspected control flow; the reproduction
design identifies the real-owner tests needed to establish them dynamically.

The gap is **explicit publication of an authored Work whose content is a
Structure**. Content already accepts structured bodies; relaxing an empty-text
check there does not make a Recipe Work public. The smallest proposal extends
the existing Work publication owner with an exact Structure-backed decision.
It does not fabricate notes, a TextContribution, a Content revision, or catalogue
provenance. Implementation waits for the public-scope decisions below.

## Established current behaviour

### Positive audience admission and safety are different owners

`services/main/src/modules/work/public-patterns.ts:28–38` defines
`publishedWork`: a CreativeWork has a MainVersion with a PublicationSelection
matching a contribution's **current** public PublicationDecision and exact,
unerased selected draft. Publishing a contribution without Main selection does
not establish this predicate. `publicWork` at `:43–48` admits that predicate
**or** `rv:catalogueVisible true`, and applies erasure/protection exclusion.
Consumers needing selected text use `publishedWork`; those needing a public
Work candidate use `publicWork`. Preserve this distinction.

`services/main/src/modules/work/read-header.ts:31–43` computes that candidate
and otherwise requires a verified principal, acting subject and
`AccessAdmissionRegistry.canReadWork`. Its `:79–86` repeats private authority
and summary disclosure after hydration. `services/main/src/modules/disclosure/read.ts`
does not decide whether authored content has been published: `:162–181` applies
governance, parent Work and read-gate restrictions, and `:202–210` maps results
to visible/tombstone/hidden. `:64–67,182–187` applies suitability defaults for
noninteractive delivery; interactive reads do not apply that default in this
module. Do not silently turn publication into a new interactive age policy.

### Creation and catalogue visibility

`services/main/src/routes/works.ts:104–124` distinguishes `authoring: 'own-work'`
from catalogue evidence. `services/main/src/modules/work/activate.ts:305–319`
adds catalogue visibility/provisional/provenance fields only for catalogue
intent. `services/main/src/modules/work/catalogue-import.ts:205` writes the
catalogue flag for admitted imports. `apps/web/features/studio/actions.ts:48–50`
creates the cook's own Work with `own-work`; it supplies no catalogue flag.
That flag is already owned catalogue behaviour, not a missing general publish
button. If the owners choose to expand its meaning instead, stop this proposal
and change that owner; do not add a parallel publication mechanism for the same
decision.

### Recipe and ordinary Structure reads

`services/main/src/routes/recipes.ts:218–225` reads through `workRead` with the
requested acting subject, returning a Recipe page/null on success or mapped
Work-read errors, with `private, no-store` caching. At
`services/main/src/modules/recipe/work-page.ts:287–305`, the reader:

1. Admits the Work basis and verifies `schema:Recipe`.
2. Resolves the Structure of the selected MainVersion.
3. Checks Recipe profile, Work owner and component.
4. Reads the **live Structure head**, not a separately published revision.

Measures also come from that live head (`:310`); the Work is re-fenced after
hydration (`:329–337`). The header resolver
`services/main/src/modules/structure/graph.ts:113–155` establishes current
head, active generation, manifest, component and owner; `:158–164` rejects two
Structures on one MainVersion. Existing immutable revision reads are already
available at `services/main/src/modules/structure/read.ts:180–218`.

Ordinary `/v1/compositions/{id}`, exact-revision and occurrence reads use
`services/main/src/routes/compositions.ts:151–160,565–602,626–635` and
`services/main/src/modules/composition/disclosure-read.ts:13–25`: public Work
or explicit private read authority, followed by disclosure. They do not use
the editor's edit permission. Edit-authorized pre-reads exist separately for
stage/import context (`routes/compositions.ts:240–252`) and stored measures
(`routes/recipes.ts:176–186`).

### The author-preview qualification

The current author can edit without an individual Recipe grant:
`services/main/src/modules/access/baseline.ts:83–89` maps `recipe.edit` to
`author-work`. However `canReadWork` (`modules/access/admission.ts:492–496`)
uses `scopedResourceDecision` (`:320–363`), whose Work baseline tests publicness
(`modules/access/baseline.ts:224`) and otherwise needs an open read gate,
representation and grant. It does not add the live author fallback there.
An ungranted author can therefore be refused a private Recipe page despite
being allowed to edit. The existing authoritative proof is
`modules/access/author-baseline.ts:98–115`, using current controller,
maintainer-set and sealed creation-receipt evidence; do not build an editor
read bypass or another author registry.

The existing real Recipe-page fixture explicitly grants **both** edit and read
at `tests/qa/integration/recipe-work-page.test.ts:21–26`, creates ingredient
and step occurrences with no notes (`:30–75`), and proves private author reads
and unrelated-reader refusal (`:84–100`). It does not establish ungranted
ordinary-author preview.

### Current audience matrix

Assume valid, available bytes and no applicable erasure/protection/governance
restriction. Anonymous/unrelated refusals below mean the indistinct Work
unavailable response (404), not a disclosed private title.

| State | Anonymous or unrelated reader without a grant | Author with acting subject |
| --- | --- | --- |
| Own-work, ingredients/steps, no notes or catalogue flag | 404 | 404 without current private-read authority; readable with it |
| Public text contribution, not Main-selected | 404 | Same private-read fallback |
| Current public text publication is Main-selected | Public Work and current Recipe Structure | Public |
| Admitted catalogue Recipe, no notes | Public Work and current Recipe Structure | Public |

Thus “no-notes Recipe cannot be public” is too broad: a catalogue-visible
Recipe can already be public. The missing cook journey is intentional
publication of **own-work**, without creating unnecessary prose. Also, current
public text/catalogue paths expose live Structure edits. A new exact-publication
branch alone cannot protect drafts on those alternative paths.

### Publication boundaries already present

- `services/main/src/modules/contribution/publish.ts:66–75,297–303` rejects
  empty text; `:337–346` records original-contribution/public attestation in a
  graph decision. Main selection at `routes/publication.ts:66–98` requires
  contribution, publication decision and expected selection predecessor.
- `services/main/src/modules/content-publication/publish.ts:122–130` already
  allows nontext structured Content; `services/main/tests/g-593-publication-body.test.ts:19–25`
  proves this. Work descriptions cannot disclose the Work
  (`modules/access/semantic-disclosure.ts:105–106`). A Content publication head
  is consequently insufficient evidence for the Work page.
- Content pins and settles its own exact revision/digest/epoch, using graph
  receipts for recovery (`modules/content-publication/README.md:3–38`;
  `services/main/tests/content-publication.integration.test.ts:61–129`). Keep
  this protocol for optional Content/notes/media; Structure manifests already
  have their own custody and need no Content copy or pin.
- Native name visibility also uses text-or-catalogue evidence:
  `infra/jena/command-module/src/main/java/com/rezics/jena/PublicNameProjection.java:103–105,122–161`.
  Updating only TypeScript would produce inconsistent public names/search.

## Questions that precede implementation

These are owner decisions, **not approvals established by this report**.
Trust-ops proposes the operation matrix with Launch input and Program approves
(`docs/goals/trust-ops/GOAL.md:61–64`). `de499` is referenced in this brief and
its task file; its original decision message was not found in inspected Goal
state. Supply that message or a new recorded decision with these answers.

1. **Program + Launch + Trust-ops:** Is a Work publishable when its public
   content is an explicitly selected Structure? Which existing profiles may
   opt in for the first public scope? Can a current represented Work maintainer
   make this decision, or is an independent review required? Should the new
   operation be public or behind a selected platform group until approved?
2. **Program + Launch:** On subsequent edit, should the public page retain the
   last published immutable revision, become unavailable until republished, or
   follow future edits? Recommended engineering proposal: retain an exact public
   revision and require republish. This is not an approved product policy. If
   following edits is approved, record that expanded disclosure expressly and
   bind its revocation semantics; do not infer it from a Structure's existence.
3. **Program + Trust-ops, with Launch:** Under that policy, what may public
   text and `catalogueVisible` expose when the Work also has a Structure?
   Preserve public catalogue metadata unless its owner decides otherwise, but
   decide whether structured payload/history needs separate selection. If the
   approved answer changes catalogue/import behaviour, obtain that Goal's
   change before claiming draft privacy across all paths.
4. **Trust-ops + Program:** Is an original-contribution attestation bound to
   admitted Structure provenance sufficient, as for original Text publication,
   or must a current RightsStore use assessment authorize structural expression?
   What evidence covers contributions by other editors, imported instructions,
   referenced materials and media? Which rights bases are in first scope?
   Unknown/unsupported bases must remain refused; Work edit authority is not
   rights clearance.
5. **Trust-ops:** Which publication, structure and parent-Work enforcement
   effects must deny publication and which suppress subsequent reading? What
   suitability and target-media checks apply? Disclosure's current effect list
   is `modules/disclosure/read.ts:53–57`; a publication-only enforcement effect
   is not automatically a disclosure restriction.
6. **Access/Trust-ops + Program, with Launch:** May a current controller and
   maintainer privately preview an authored native Work without an individual
   `work.read` grant? Preserve closed gates, recovery, explicit policy
   precedence, identity verification and transfer revocation. This fixes a
   separate existing read/edit gap and must not be granted silently by publish.
7. **Launch:** Should one Publish click include optional notes and Structure,
   and what does it display if one operation succeeds and another remains
   pending/refused? The existing owners are separate transactions. A GUI must
   not promise all-or-nothing publication without an approved backend contract.

## Proposed generic rule and contract

Subject to those answers, add one structured-source alternative to the existing
Work public decision, not a new visibility store:

> An unerased, unprotected Work may be a public candidate when its current
> Work-owned publication decision explicitly selects a valid Structure of its
> selected component, an exact immutable Structure revision and manifest, with
> approved public disclosure and rights evidence. Current Access, governance,
> suitability and exact-source fences still determine each disclosure.

An empty Structure or existence of a Structure is not a publish decision. The
same rule applies to any reviewed Work-owned structured profile, without a
`schema:Recipe` branch in audience policy. Reuse
`StructureProfileRegistration` (`modules/structure/profiles.ts:26–100,122+`)
and its existing owner declarations, such as Recipe at
`modules/recipe/structure-profile.ts:140–165`. If an opt-in declaration is
needed, add it there. Do not opt in every profile merely because it has a
Structure: a Collection/Zone owner is not automatically a CreativeWork. A
second profile in tests proves generic dispatch without opening that profile
in production or requiring a new registry.

### Explicit API

Proposed path: `POST /v1/work-publications`, declared in the existing
`services/main/src/routes/publication.ts`, with a structured-source body
variant. The path/profile names are proposed public contract names to freeze
with the owners; do not derive a Recipe-specific endpoint. Its reviewed input:

| Field | Meaning |
| --- | --- |
| `profile` | Reviewed structured Work publication operation shape |
| `work`, `actingSubject` | Native Work and represented publishing actor |
| `expectedWorkHead`, `expectedMainVersion` | Bind Work/component selection, refusing a changed owner basis |
| `structure`, `expectedStructureHead` | Exact saved source; server resolves owner/component/profile/generation/manifest |
| `expectedPublicationHead` | Null for first decision, otherwise exact CAS predecessor; omitted is invalid |
| `disclosure` | Explicit `public`, never inferred from Save |
| `rightsBasis`, approved evidence reference if required | Attestation/assessment selected by Trust-ops; no general permissive string |

Proposed capability names are `work.publish` and `work.withdraw-publication`,
both scoped to `work:publish:<work>`, with `work:edit` as the existing OAuth
scope if Trust-ops approves it. Access's existing maintainer/author proof decides
who can exercise them. Use a discriminated operation body (`publish` with the
exact source fields above; `withdraw` with Work, actor and expected publication
head). These are proposed names, not permissions already present in the code.

Require bearer identity, approved OAuth scope and a retained `Idempotency-Key`.
All supplied heads and authority are verified server-side. Compute the request
digest from the submitted intent, not volatile heads resolved afresh on retry.
Resolve a terminal same-key receipt before rechecking a changed source; an
identical replay returns the original outcome, and a different intent under
that key conflicts. Source and publication-head CAS belongs in the same native
transaction as the decision, durable receipt/proof and typed outbox event.

The success receipt identifies Work, MainVersion/component, Structure,
selected revision/generation/manifest, publication decision, predecessor,
admission, digest, authority evidence and owner basis; public responses expose
only the appropriate subset. Use the current Work receipt custody/local-basis
contract, not a new sequence or receipt store. Return 201 for first success,
200 for terminal replay, 202 plus the existing admitted-operation reconciliation
reference for an unresolved outcome, and typed 400/401/403/404/409/503 problems
for invalid/unauthenticated/denied/missing/stale/unavailable states as appropriate.
Neither 202 nor an ambiguous graph result is “published”. Register exposure,
rate-limit family and `openApiOperations`; new public exposure needs Trust-ops
review. Keep route registration add-only if another module is split out.

Provide server publication state on the existing Work read response, including
the selected structured source and its effective public/withheld state for the
caller. Pending operation status uses existing admitted-operation reads. Do not
infer publication status from Text or from an author successfully reading a
private page. A withdrawal variant uses the same owner operation, expected
decision predecessor and durable receipt. It withdraws structured authority;
other approved public grounds remain independent and must be reported honestly.

### Gates and revision discipline

- Reuse Access verify/register/claim/seal, participation restrictions and
  current author/maintainer proof. Registration checks platform participation
  (`modules/access/admission.ts:1019`; `modules/safety-queue/participation.ts:10–21`).
  A generic publication action/scope extends this owner; Recipe edit permission
  alone cannot decide public exposure. Transfer, expired identity, closed gates
  and restore holds refuse dispatch. Register the existing receipt-family
  reconciliation adapter, including strong revocation.
- Verify exact Structure custody/profile and admitted source provenance. A
  bounded exact-root check must not enumerate all Works or copy the Structure
  into Content. Existing structure/page integrity checks remain authoritative.
  If safety/rights review needs every occurrence, declare its bound and reuse
  existing paging/staging; do not quietly truncate or add a second seal engine.
  A requirement for unbounded whole-Structure review changes the estimate and
  needs another brief.
- Reuse RightsStore if the assessment option is chosen. It already supports
  `scopeKind: 'work'`, `workId`, `component: 'structure'`, expression kind,
  use family/kind/scope, basis/outcome, extent/evidence and obligations
  (`modules/rights/schema.ts:10–21`; `modules/rights/store.ts:18–41`). Material
  identity has no exact Structure revision (`store.ts:292–300`). Trust-ops must
  choose a reviewed exact-revision evidence convention or authorize a Content
  migration. `currentPublicDomainAssessment` (`:172–185`) is specific to body
  and `rezics:public-text`; its conclusion cannot authorize Structure. If
  original attestation is approved, retain exact source/actor evidence in the
  immutable decision and reuse that precedent; do not record a fake assessment.
- Apply approved structure/publication/parent-Work safety fences during admission
  and disclosure, with a defined consistency boundary for changes during the
  graph commit. Reuse existing Access claims, revocation and reconciliation
  machinery; an independent SQL preflight is not proof of atomic safety.
  Publish does not make referenced private targets or draft media public. Recipe
  currently withholds target resolution (`work-page.ts:300–305`); preserve that
  rule unless its owner explicitly changes it.
- Under the recommended exact-revision option, public readers use the selected
  immutable root even after a new private edit. Authorized author previews may
  read draft roots. Direct Structure current/revision/occurrence routes must
  resolve the same source decision: public Work readability alone cannot grant
  access to every historical or future Structure revision. Check this also when
  text or catalogue visibility is the Work's public ground. Bind continuations
  to publication decision and exact root; withdrawal/replacement gives the
  existing typed restart/stale outcome and no mixed-page data.
- Re-fence after hydration; unavailable owners fail closed. A withdrawn source,
  erased root, missing immutable object or invalid profile cannot be replaced
  silently with a draft head. Optional notes continue through their existing
  contribution/Content owner; selecting structured content does not authorize
  private notes, Content embeds or media.

## Reproduction and acceptance identity

No existing Recipe acceptance case explicitly names no-notes publication.
`scripts/qa/cases/recipes.ts:5–31` registers RECIPE01–RECIPE06 for occurrences,
scaling, import, Realm variants, measures and source withdrawal. Propose
**RECIPE07**, to be registered by the implementing slice: “An own Recipe with
ingredients and steps and no notes remains private until explicit structured
publication, then an anonymous reader sees exactly its approved Structure
without fabricated text.” All subscenarios below are assertions of proposed
RECIPE07, not already-green registered IDs. Existing WORK10 is a relevant
publication recovery case (`scripts/qa/cases/native-work.ts:54–58`), but new
Structure recovery evidence is required before claiming coverage for this path.

Use `tests/qa/integration/recipe-work-page.test.ts:21–100` and
`tests/qa/fixtures/author-credit.ts:341–346` to build once through real APIs:

1. Create own Recipe, Structure, one ingredient and one step, without notes.
   Check no catalogue flag, TextContribution, selected public text or Content
   publication was created. Read as anonymous, unrelated member, ungranted
   author, then author with explicit read grant. Characterize the matrix above
   before changing it; the preview assertion changes only after question 6.
2. Create an admitted catalogue Recipe without notes through its existing
   owner, and characterize its currently public Structure. Also publish text
   without selecting it, then select it. These controls distinguish content
   existence/publication from Work disclosure and expose alternate public paths.
3. Publish the own Recipe through the new operation. In a **separate anonymous
   context**, prove Work header and Recipe ingredients/steps/measures are public
   while private notes, targets and media remain unavailable. Assert exact
   decision/root evidence and absence of synthesized prose/catalogue intent.
4. Exercise actor denial, stale Work/Structure/publication heads, concurrent
   edit/publish and two publishers, same-key replay/conflict, lost response,
   transfer/revocation, recovery hold, invalid profile/missing bytes, enforcement
   during hydration and withdrawal. Under exact selection, draft edit remains
   private, republish changes the public root, and all continuation/direct-read
   routes enforce it. Repeat alternate text/catalogue grounds.
5. Exercise the same kernel operation with a second reviewed Work-owned test
   Structure profile, including non-Recipe qualifiers, using existing profile
   discovery/fixtures. It must succeed without a Recipe policy branch. Do not
   production-enable a new vertical as the price of testing generic behaviour.

Existing focused anchors to retain include
`services/main/tests/work-read.integration.test.ts:217–220,276–281`,
`services/main/tests/recipe-work-page.test.ts:248–278`,
`services/main/tests/baseline-recipe-edit.test.ts:6–11`,
`services/main/tests/access-public-disclosure.test.ts:37–40`, and
`tests/qa/integration/content-publication-native.test.ts:34+`. A second kind
and real anonymous context are stronger evidence than a mocked `isPublic=true`.

## Ordered one-session slices

The finish line is a functionally complete first public scope, not external
deployment readiness (`docs/operations/external-conditions.md`). Recipe author
and reader journeys are first scope (`docs/goals/launch/GOAL.md:44–54`). Each
slice below is **A**, because its stated function is incomplete or unsafe
without it. Estimates are planning budgets for one Luna `max` session including
its focused checks, not measured runtimes. Total is 510 minutes, leaving 90
minutes in a ten-hour window for handoffs/build reuse. Resolve owner questions
**before** dispatch: waiting for policy or building assessment machinery not
chosen by the owners is not included in this estimate. Rebase anchors at each
dispatch and claim every touched path; never edit another Goal's claimed files.

Mechanisms lines below use existing IDs from
`scripts/static/mechanisms.ts:25–40,61–86`. No Work publication mechanism is
currently mapped. Extending its real module does not justify a duplicate
registry; `none` is appropriate where a slice only extends that unmapped owner.

### 1. Characterize audience and establish private preview — 45 minutes, A

**Files/anchors:** `modules/access/admission.ts:320–363,492–496`,
`modules/access/baseline.ts:185–186,224`,
`modules/access/author-baseline.ts:98–115`; paths are under
`services/main/src`. Existing test `tests/qa/integration/recipe-work-page.test.ts:21–100`.

**Change:** add the real-owner current-matrix characterization and, only if
question 6 is approved, extend the existing Work private-read decision with its
live author/controller proof. Preserve policy/gate precedence and revoked
controller denial. This is a general authored-Work fix, not a Recipe exception.

**Proof:** new `tests/qa/integration/authored-work-private-preview.test.ts`,
existing `services/main/tests/baseline-recipe-edit.test.ts` and
`tests/qa/integration/recipe-work-page.test.ts`; no read-grant shortcut in the
new author's preview fixture. Covers author, unrelated user, explicit policy,
closed gate, transferred control and recovery hold.

**Acceptance:** RECIPE07 private/author-preview assertions become executable;
publication assertions remain red/unregistered until slice 3/5. Do not claim
the whole case green. **Mechanisms:** `access-authority: extend`.
**Migration/build:** Access no; Content no; native no. **Waits:** Trust-ops/Access
and Program's preview decision. If owner keeps explicit grants, retain the
characterization and have Launch use the approved private-read contract.

### 2. Define exact generic public-source evidence — 60 minutes, A

**Files/anchors:** `services/main/src/modules/structure/profiles.ts:26–100,122+`,
`modules/recipe/structure-profile.ts:140–165`, `modules/structure/graph.ts:113–155`;
new authored model definition `model/definitions/work-structure-publication.ttl`
(name finalized under the current model convention), using existing
`model/definitions/content-publication-v1.ttl` and
`model/definitions/structure-composition-v1.ttl` as inspected meaning boundaries.
`services/main/src/infrastructure/profile.ts:19–39` is the native-health gate.

**Change:** declare reviewed opt-in in the existing profile declaration and
define the Work-owned structured decision, predecessor and exact source
constraints. It is a new meaning, not an in-place tightening of a pinned
definition or a text PublicationDecision with missing required text fields.
Define the corresponding withdrawn decision/source absence. Preserve existing
Structure revision and manifest formats.

**Proof:** new `model/tests/work-structure-publication.test.ts` and
`services/main/tests/structured-publication-profile.test.ts`; reuse
`model/tests/work-metadata-structure-turtle.test.ts` and
`model/tests/structure-collection-turtle.test.ts`. Reject wrong owner/component,
missing source/root, conflicting heads and non-opted-in profile; test generic
discovery with a second Work-owned profile. **Acceptance:** RECIPE07
generic-source validity assertions; it does not yet publish a page.

**Mechanisms:** `none`. **Migration/build:** no Access/Content migration;
`task gen` needed, generated artifacts restored before handoff; native image
required before activation, built once with slice 4's final native changes.
**Waits:** Program/Launch/Trust-ops questions 1–3; Kernel's current model/native
health contract. A missing health profile must continue to refuse activation.

### 3. Implement admitted publication and withdrawal — 75 minutes, A

**Files/anchors:** `services/main/src/routes/publication.ts:66–140`, new
`modules/work/structured-publication.ts` and
`modules/work/structured-publication-admitted.ts`; reuse
`modules/structure/change-admitted.ts:54–94`,
`modules/access/baseline.ts:79–107`,
new `modules/work/receipt-family.ts`, discovered by
`modules/access/receipt-families.ts:3–6,40–47`,
`modules/work/outbox-event.ts:7+`, discovered by
`modules/outbox/event-handlers.ts:41–65`,
`modules/work/strong-revoke.ts:55–90` and its later dispatch branch;
`modules/contribution/publish.ts:325–351` as publication/receipt precedent.
Register proposed RECIPE07 in `scripts/qa/cases/recipes.ts:3–34` and
`scripts/qa/coverage/recipe.ts:3–36` as its evidence files become available.

**Change:** the explicit API, approved authority and rights/safety gates,
canonical digest, source/publication CAS, immutable success/cancellation receipt,
typed outbox and withdrawal. Reuse existing native command executor and receipt
custody. Add the action to existing Access proof/receipt adapters and strong
revocation, not an authorization bypass. Return pending when outcome is unknown.
Route response schema belongs with this change; generated clients follow it.
Add receipt-family and event declarations at those existing owner-discovery
seams; do not edit the central discovery tables to hardcode another family.

**Proof:** new `services/main/tests/structured-work-publication.test.ts` for
digest/replay/stale/denied outcomes and admission wiring; retain
`services/main/tests/g-593-publication-body.test.ts` so structured Content and
empty text boundaries do not change. If an assessment is selected, add exact
Structure current-use tests in `tests/qa/integration/rights-use-assessment.test.ts`
and a current-use reader in `modules/rights/store.ts:163–185,292–300`, not a
second rights evaluator. If original attestation is chosen, test source
provenance and that imported/unknown bases are refused.

**Acceptance:** RECIPE07 command/rights/denial/replay assertions; no whole-case
green before the real native and reader slices. **Mechanisms:**
`access-authority: extend`, `governance-restriction: consume`; add
`rights-evaluation: consume` only for an approved assessment-backed branch.
**Migration/build:** Access no inherent DDL change (action/scope are bounded
strings in `services/main/migrations/access/001_admission.sql:22,31,45,60`);
Content no for approved original attestation. If exact assessment identity needs
DDL, reserve a Content migration number at dispatch and split that owner work
before this slice rather than guessing it inside the time budget. Native
activation waits slice 4. **Waits:** slice 2; Trust-ops authority/rights/safety
decisions and Program exposure approval. New public operation review is mandatory.

### 4. Enforce native evidence and public candidate parity — 75 minutes, A

**Files/anchors:**
`infra/jena/command-module/src/main/java/com/rezics/jena/CommandService.java:1268–1351`,
`RevisionClasses.java:60,128`, `PublicNameProjection.java:103–105,122–161`;
`services/main/src/modules/work/public-patterns.ts:28–48`,
`modules/composition/disclosure-read.ts:13–25` and
`modules/access/semantic-disclosure.ts:105–106`. Existing native
`CommandPolicy`/`HeadCasPolicy`/`CommandInvariant` remain the executor, CAS and
validation owners; inspect their active invariants before adding a narrow
source decision guard. Do not introduce a new native command subsystem.

**Change:** validate new decision/source transitions under the reviewed shape
and native admission rules, and add one structured public-candidate branch to
common Work visibility. Keep selected-text bindings text-only. Extend native
name projection to the same graph evidence, with bounded owned probes and
withdrawal. Audit direct copies of text/catalogue publicness in the touched
read/query/search/native area; route them to the owner predicate or record
cross-Goal changes needed before opening. Public search names may describe a
published Work; this does not invent a notes-body search MatchUnit.

**Proof:** existing
`infra/jena/command-module/src/test/java/com/rezics/jena/PublicNameProjectionTest.java`,
`infra/jena/tests/work-name-scope-basis.test.ts`,
`services/main/tests/access-public-disclosure.test.ts`; new
`tests/qa/integration/structured-work-publication-native.test.ts`. Use real
Access/native dispatch for source-head race, concurrent publishers, wrong source
owner, absent shape, erased root, native names and withdrawal parity.
**Acceptance:** RECIPE07 native admission/common candidate assertions.

**Mechanisms:** `access-authority: consume`, `governance-restriction: consume`.
**Migration/build:** Access no; Content no; native image **yes** and generated
model **yes** (`infra/jena/Dockerfile:7,56–57` embeds artifacts). Use current
Task generation/build/pinning procedure; restore noncommitted generated outputs.
Do not add or replace tools. **Waits:** slices 2–3, current Kernel native union
and Program build/QA slot; no source overlays in another worktree.

### 5. Resolve exact public roots across all read paths — 75 minutes, A

**Files/anchors:** `services/main/src/modules/work/read-header.ts:31–43,79–86,108–120`,
`modules/work/read-session.ts:112–129` (dependency rechecks),
`modules/recipe/work-page.ts:287–337`,
`modules/structure/read.ts:180–218`,
`routes/compositions.ts:151–160,565–602,626–635`,
`modules/disclosure/read.ts:162–181,290–344` and
`routes/recipes.ts:195–225`. Reuse the source resolver added in slice 3;
no per-reader independent publication authority.

**Change:** add server Work publication state and, under the approved exact-root
policy, use that source for Recipe page/measures and public Structure reads.
Private authorized preview remains explicit. Enforce exact revision admission
on direct current/history/occurrence paths, alternative text/catalogue grounds,
pagination and any export/preview consumer that can return structured bytes.
Retain existing safety overlay, rechecks, response budgets and typed stale
continuation. Add exact Structure disclosure where currently only the Work
basis is checked. Do not expose private root identities through public state.

**Proof:** new `tests/qa/integration/structured-work-publication.test.ts`,
existing `tests/qa/integration/recipe-work-page.test.ts`,
`services/main/tests/recipe-work-page.test.ts`,
`services/main/tests/work-read.integration.test.ts`. Assert anonymous root before
and after draft edit/republish; direct revision/occurrence privacy; catalogue and
selected-text controls; wrong/old cursor, missing bytes, structure-only
enforcement, parent restriction moving during read and private notes/media.
**Acceptance:** RECIPE07 anonymous/exact-revision/generic-read assertions.

**Mechanisms:** `access-authority: consume`, `governance-restriction: consume`;
`rights-evaluation: consume` if current assessments are the approved disclosure
basis. **Migration/build:** no inherent Access/Content migration; native no
additional build for TS-only changes. **Waits:** slices 1 and 4; approved
revision/catalogue policy and catalogue/import owner changes if needed. Any
cross-Goal export/SEO change is claimed or handed off, never silently omitted
from the privacy acceptance.

### 6. Prove settlement, revocation and recovery — 60 minutes, A

**Files/anchors:** `services/main/src/modules/access/receipt-families.ts:40–47`,
`modules/work/strong-revoke.ts:55–90`, existing
`modules/work/receipt.ts` and `modules/outbox/receipt-custody.ts` (owner custody
used by `modules/work/activate.ts:63,357–371`); new publication adapters from
slice 3, including `modules/work/receipt-family.ts` and the Work outbox handler.
The Access discovery file is a read-only seam unless its generic contract must
change. Pattern:
`tests/qa/fault-recovery/content-publication-recovery.test.ts:48+`, not a new
Content pin protocol. Native and Access own durable truth; timers cannot
convert unknown dispatch into success or retract committed evidence.

**Change:** finish existing admitted-operation reconciliation/strong-revoke
dispatch for the new action and fix only failures exposed by this focused
recovery proof. Lost response, unsealed committed receipt and replay must settle
once. No exact graph receipt remains pending. Cancellation preserves authored
Structure custody. Restore holds never serve speculative source selection.

**Proof:** new
`tests/qa/fault-recovery/structured-work-publication-recovery.test.ts`, testing
interrupt after native commit/before Access seal, fresh reconciliation, repeated
withdrawal/revocation, no-receipt uncertainty and owner restore hold. Use one
isolated prepared fixture and native build from slice 4.
**Acceptance:** RECIPE07 recovery/revocation assertions and additional WORK10
evidence for the structured path; do not claim unrelated WORK10 cases rerun.

**Mechanisms:** `access-authority: consume`, `governance-restriction: consume`.
**Migration/build:** no inherent Access/Content migration; no extra native
build unless a native defect is fixed. **Waits:** slice 5; Program recovery/QA
slot and current custody seam. If pending receipt/custody owners change, adapt
to their landed contract rather than build another reconciliation loop.

### 7. Integrate Launch editor without notes — 75 minutes, A

**Files/anchors:** `apps/web/features/recipe-editor/api.ts:45–67`,
`publish.tsx:11–12,29–42`, `editor.tsx:83–120`,
`publish-settled.ts:16–19`, `saves.ts:180–195,237–264`,
`messages.ts:22,73` and its existing locale files; consume generated client
contracts. Existing `apps/web/features/studio/text-api.ts:136–146,177–188`
continues to own optional notes publication/selection.

**Change:** Save ingredients/steps/measures/title, wait every relevant save lane,
obtain the settled source and server publication predecessor, then call the
generic explicit publish API with retained retry key/acting subject. Empty
notes create no Text. Remove mandatory-notes validation, replace all
`Boolean(notes.publicationHead)` status proxies with server Work publication
state, and read it back after success/reload. Pending, stale, revoked or partial
outcomes must not display a false Published badge/link. Preserve entered data
on failure. Optional notes follow the approved order/partial-outcome policy;
do not invent a frontend transaction across owners.

**Proof:** extend
`apps/web/features/recipe-editor/publish-settled.test.tsx:20,49,72,83`,
`saves.test.ts:225,269`, `fixtures.ts`, and
`recipe-editor.stories.tsx:219–232` (existing `PublishesWithNotes`). Add a
no-notes story and exact-root/server-status, retained key, queued-save,
session-expiry and partial-outcome assertions. Run the changed stories and
inspect actual screenshots under Launch's Storybook review skill; one dev
server against the shared backend, stopped before handoff.
**Acceptance:** RECIPE07 UI initiation/status/retry assertions; strengthen
“Author a recipe” and “Read a recipe” evidence at
`scripts/qa/cases/launch-coverage.ts:105–122`.

**Mechanisms:** `access-authority: consume`. **Migration/build:** neither
Access nor Content migration; native no. Required generated contract and
`task web:typecheck` after route changes. **Waits:** Kernel slices 5–6 and
Launch optional-notes/partial-state decision. This is a **Launch-owned dispatch**,
not product work for this report's worker or an unclaimed Kernel edit.

### 8. Prove the anonymous cook-to-reader journey — 45 minutes, A

**Files/anchors:** `apps/web/tests/recipe-authoring.e2e.ts:82–99,196–229`
(currently supplies notes and reads in the same signed-in context),
`scripts/qa/cases/recipes.ts:3–34`, `scripts/qa/coverage/recipe.ts:3–36`,
`scripts/qa/cases/launch-coverage.ts:105–122`.

**Change:** extend the existing journey with own Recipe/no notes, private
before-publish denial, explicit publish, fresh anonymous context, reload,
private draft edit, approved republish and server-confirmed public state. Add
the browser evidence to RECIPE07 and Launch coverage declarations; do not add a
second fixture/data-preparation owner. Fix only defects this journey exposes
in claimed Kernel/Launch slices.

**Proof:** run the changed explicit browser file once through goalctl, plus
the exact RECIPE07 evidence files not already proved at the landed commit.
An owner/private preview is not anonymous-public evidence. Registry must point
to real test names; no `covered` label standing in for execution.
**Acceptance:** proposed RECIPE07 can now be wholly green when all its focused
owner/native/recovery/browser evidence passes; existing Recipe author/read
Launch capability evidence gains the no-notes scenario. **Mechanisms:**
`access-authority: consume`. **Migration/build:** neither migration; reuse
native image. **Waits:** slice 7, Kernel's settled backend and Program QA slot.
Launch owns the browser path; Program retains broad regression/opening checks.

### B/C work outside this implementation sequence

| Work | Class and reason | Owner/dependency |
| --- | --- | --- |
| Full phrase search over instructions and structure qualifiers | B: public page and existing name discovery can function without a new structured body-search lane; first-scope search requirement could promote it to A | Kernel/Launch must decide against the existing search owner, not a new registry |
| Enable additional structured verticals | B: prove generic capability in fixtures now; production opening of extra kinds is not required for the cook journey | Their current Structure/profile owners and Program exposure matrix |
| Imported/licensed/third-party structured-publication rights beyond approved first-scope bases | B only if first scope is explicitly original-own-work; A if owners include these publication jobs | Trust-ops/Rights, potentially Content migration, then Kernel |
| Bulk publication, background whole-Structure review, new seal workflow | C: no evidence the bounded first cook journey needs another lifecycle | New workload/owner brief, only if real budgets fail |
| Provider credentials, hostnames, production infrastructure and other external conditions | Not Goal work and not a workaround slice | Maintainer's external-conditions list |

## Validation and remaining limits

For implementers, use only their explicit files through
`bun scripts/goal/goalctl.ts test <files>`; retain run IDs. Use workspace
typechecks, changed-directory lint and changed-file ast-grep via the existing
Task/worker procedure. Preview affected tests without running the wider plan;
hand cross-claim tests to the manager. New model/native meaning requires
generation/native health and one composed real-native proof. Only Launch's
UI/browser slices authorize their focused Storybook/browser journeys. No whole
tier or broad regression belongs in a Luna worker's ten-hour estimate.

This specification checked source/test definitions only, not human usability,
runtime catalogue/no-grant outcomes, native parity after the proposed change,
capacity of reviewing a large Structure, or a production deployment. The real
owner reproduction above settles audience behaviour; a recorded owner decision
settles public revision and rights policy; composed native recovery tests settle
receipt/fence behaviour. A ten-hour estimate assumes original-own-work or an
already-supported assessment convention, bounded fixtures and current owner
seams. A required new assessment identity migration, independent moderation
workflow or unbounded closure review requires reslicing before dispatch.

The design's external evidence is deliberately limited. [Schema.org Recipe](https://schema.org/Recipe)
(development vocabulary inspected 2026-10-11) represents ingredients and
instructions as structured values/items; it does not require REZICS notes or
authorize disclosure. [Google AIP-155](https://google.aip.dev/155) motivates
retained request identity for retry after uncertain responses; it does not
prove REZICS's commit/reconciliation guarantees. Existing REZICS owner code
and the proposed adversarial tests, rather than those sources, establish the
contract here.
