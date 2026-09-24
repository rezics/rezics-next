# Fixed first profiles

`yarn gen` currently copies the 12 reviewed Turtle profiles into
`generated/model/shapes/`, writes their SHA-256 manifest for the Fuseki command
module, and generates the TypeScript profile registry at
`packages/model/src/generated/profiles.ts`. `yarn gen:check` detects drift. This
is the first P0.3 increment; the authored TypeScript IR, typed schemas,
arbitraries and command-module equivalence cases remain in progress. The
historical helpers and candidate evidence below remain available until those
cases reproduce through the generated shapes.

`definitions/realm-standing-rating-observation-v1.ttl` validates six explicit
Realm, RatingContext, Work, MainVersion, Observation and Revision focuses. The
observation has an opaque standing slot and exact revision head. Available
revisions carry an integer 1–10; withdrawn revisions carry no value. Four
distinct event-time fields and an optional exact predecessor are required.
The helper pins the shape bytes and the supplied references, value and prior
revision. [Executed candidate evidence](tests/evidence/2026-09-24-realm-standing-rating-observation-profile.json)
covers first submission, correction, withdrawal and rejected type, link, slot,
value, predecessor and time cases. The guarded Main command uses this pinned
helper, with separate Account/Access admission and conditional slot/head writes.
Live HTTP, relay and retained recovery checks cover storage; the shape alone
does not establish those properties.

`definitions/realm-standing-rating-context-v1.ttl` validates two explicit
focuses: an active Realm and a distinct active RatingContext with reciprocal
links. The question is an exact English literal; target grain, integer 1–10
scale, standing cadence, Account-principal population and latest-per-rater mean
policy are pinned. The helper checks the shape digest and Jena SHACL 6.2.0/Java
21. [Executed candidate evidence](tests/evidence/2026-09-24-realm-standing-rating-context-profile.json)
records one valid and seven rejected type, link, question, grain, scale, cadence
and population cases. Main runs the pinned helper before its guarded context
command; runtime authority, relay and retained recovery have separate checks.
The first standing observation command uses this fixed Context profile.

`definitions/classification-context-v1.ttl` validates a fixed Global
ClassificationContext, an active Realm, and a distinct Realm
ClassificationContext linked to that Realm. Global is isolated and has no
fallback edge. The Realm context has the fixed
`classification-inherit-global-v1` policy and points only to Global. The
pinned helper binds both directions of the Realm/context link to explicit
focuses, leaving `space-realm-v1` unchanged. [Executed context candidate evidence](tests/evidence/2026-09-24-classification-context-profile.json)
records valid and rejected missing-type, wrong-link, policy, fallback and
Global-cycle cases. Main uses the helper before its guarded context command;
the SHACL check itself does not confer authority or make classification decisions.

`definitions/classification-proposition-v1.ttl` is the first shared vocabulary
candidate. It validates five distinct focuses: an active SKOS ConceptScheme,
one active SKOS Concept with a single English preferred label, a one-node
ConceptPath, a ConceptAssertion Expression, and a Global interpretation Sense.
The path's one terminal Concept is its complete ordered route in this profile;
future multi-step paths require a new definition and profile, not a reinterpretation.
`tools/validate_classification_proposition.py` pins the shape bytes and binds
every reference to the five explicit focuses. The Global interpretation scope
URI identifies a role and does not itself grant acceptance or create a Realm
classification context. [Executed candidate evidence](tests/evidence/2026-09-24-classification-proposition-profile.json)
records valid and rejected type, link, interpretation-scope and duplicate-label
cases. The first native Global definition command uses this pinned helper before
guarded storage. It stores the five identities in one Sense-owned immutable
bundle, and retained recovery verifies its manifest and sealed Access admission.
The first curated Application/Decision command and effective read use the
shared Sense; broader vocabulary and application paths remain pending.

`definitions/classification-direct-decision-v1.ttl` is the first curated
MainVersion Application/Decision candidate. The two records have distinct
identities and an exact current head. Its pinned helper checks the public
Work/MainVersion pair, an active shared Global Sense, the fixed Global root or
one active Realm classification Context with reciprocal Realm and fallback
links, accepted/rejected outcome, review basis, context revision and optional
predecessor. The guarded direct decision command uses this pinned helper before
storage. Runtime evidence covers Global and two independent Realm decisions,
exact-head revision, public resolution, relay and retained recovery. The shape
check alone does not establish those runtime properties.

`definitions/realm-local-rejection-v1.ttl` validates an explicit negative
publication head for one Realm/Main Version slot, with fixed manager review,
reason and fallback policies. Its pinned Jena helper selects the rejection
focus even when its type is missing. The guarded command removes any previous
local MatchUnit while preserving the Main default and other Realm choices.
[Executed rejection shape evidence](tests/evidence/2026-09-24-realm-local-rejection-profile.json)
records valid focus and missing-slot, wrong-basis and missing-type violations.

`definitions/realm-local-selection-v1.ttl` validates references for an exact
Realm/Main Version selection slot, eligible publication and selected draft, plus
the fixed manager review basis and policy. Native admission verifies the current
publication and selected draft. `tools/validate_realm_local_selection.py`
pins its SHA-256 and checks the explicit selection focus even if its type is
missing. [Executed Realm selection shape evidence](tests/evidence/2026-09-24-realm-local-selection-profile.json)
records valid focus and rejects a missing slot, wrong basis and missing type.

`definitions/space-realm-v1.ttl` validates a public Space and a distinct Realm
capability with an owner and fixed initial membership, manager review and
Main Version fallback policies. `tools/validate_space_realm.py` pins its SHA-256
and selects both focus nodes, including when an RDF type is absent.
[Executed Space/Realm shape evidence](tests/evidence/2026-09-24-space-realm-profile.json)
checks a valid pair and rejects missing owner, missing Realm type and a changed
review policy. Realm creation and local content adoption remain separate commands.

`definitions/main-default-selection-v1.ttl` validates an exact-focus Main
Version default selection of one eligible Contribution publication and draft.
Its pinned Jena helper is `tools/validate_main_default_selection.py`.
[Executed selection shape evidence](tests/evidence/2026-09-24-main-default-selection-profile.json)
checks valid focus and rejects a missing publication decision, wrong basis and
missing type. This profile is distinct from Realm-local adoption.

`definitions/text-publication-v1.ttl` validates an exact-focus contributor
eligibility decision that names one Contribution, Work, author and immutable
selected draft, with an original-contribution rights basis and public
disclosure. `tools/validate_text_publication.py` pins its SHA-256 and the
Jena SHACL 6.2.0/Java 21 runtime. The graph decision is distinct from a
context publication selection and creates no public MatchUnit.
[Executed publication shape evidence](tests/evidence/2026-09-24-text-publication-profile.json)
checks a valid decision and rejects missing draft, private disclosure and
missing type.

`definitions/text-contribution-v1.ttl` is the first draft Contribution shape.
It requires a distinct typed Contribution node, one Work reference, author,
language and draft head. `tools/validate_text_contribution.py` pins its SHA-256
and invokes the same Jena SHACL 6.2.0/Java 21 runtime. Main validates a trusted
candidate before graph activation; the draft body is held in an immutable
manifest and does not enter RDF text indexing. This profile has no publication
selection or public MatchUnit.
[Executed Contribution shape evidence](tests/evidence/2026-09-24-text-contribution-profile.json)
records one valid candidate and two missing-property rejections.

`definitions/work-metadata-v1.ttl` is the first admitted candidate shape for one
Work and its distinct maintained MainVersion. It requires typed references in
both records, a continuity profile and an explicit metadata-only hosting policy.
It does not mint the identities or create a body, contribution or release.
The shape bytes are pinned by SHA-256 in
[`validate_work_metadata.py`](tools/validate_work_metadata.py); changing the shape
requires review and a new profile revision rather than a silent in-place edit.

The helper selects both trusted focus nodes explicitly with `sh:targetNode`, so
removing an RDF type cannot avoid validation. It invokes the pinned Apache Jena
SHACL 6.2.0 command with Java 21, checks a complete validation report and applies
a 64 KiB candidate budget. This is a local validation consumer, not a native
write path. Main still has to enforce reciprocal linkage and slot uniqueness,
assemble the coherent candidate, guard its mutable read set, admit Account/Access
authority, and atomically activate revision anchors,
receipts and outbox through Fuseki.

After obtaining the checksum-verified Apache Jena 6.2.0 distribution and Java 21
runtime, run the focused cases from the repository root:

```sh
python3 model/tests/verify_work_metadata.py \
  --jena-home "$JENA_HOME" --java-home "$JAVA_HOME"
```

The valid fixture must conform. The missing-type and missing-MainVersion fixtures
must fail with paths in the Jena report. [Executed evidence](tests/evidence/2026-09-24-work-profile.json)
records the first run. See the [plan](../docs/plan/README.md#active-execution) for
current S1 qualification and remaining work.
