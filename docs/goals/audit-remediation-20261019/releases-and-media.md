# Release and media outcome contract

Status: **pending specification, no persona proved**. This contract covers
`catalogue/releases-and-media` and scenarios C10, C11, C12, C13, C16 and the
release/media part of C20. The accepted audit decisions retain source fidelity
and separate outcome authors from implementation authors. API checks do not
qualify business-page image decoding or human usability.

## Prove selection and personas

Use the named selection `catalogue-release-media`, consisting of exactly:

- `tests/qa/integration/outcomes/catalogue/releases-and-media.test.ts`
- `tests/qa/integration/catalogue-discovery-navigation.test.ts`

The first file uses the six pending cells declared in
`scripts/qa/cases/outcomes/catalogue/releases-and-media.ts`. The second has six
ordinary integration tests. Their mapping is:

| Persona | Public release/media/navigation assertions | Saved state assertions |
| --- | --- | --- |
| visitor | Both retained sources, exact release and realization revisions, source/rights evidence, cover and Character portrait, private/withdrawn controls, advertised operations | Preference/progress GET and PUT require authentication and leave the target reader unchanged |
| stranger | Same public contract | Saves and resumes their own choice/progress; foreign reader reads and writes are denied |
| member | Same contract; membership grants no hidden source data | Same own-state contract; membership grants no foreign reader state |
| owner | Same ordinary public contract; fixture ownership grants no source-art ownership | Same own-state contract; catalogue ownership grants no foreign reader state |
| moderator | Same ordinary public contract; moderation is not source publication | Same own-state contract; moderation grants no foreign reader state |
| operator | Same ordinary public contract; no implicit evidence publication | Same own-state contract; platform status grants no foreign reader state |

Hidden controls have no explicit read grants to these ordinary acting subjects,
including the operator. Source preparation may use a separately scoped import
authority through `grantFixtureAuthority`; it must not grant ordinary readers
the private-control access it is meant to test.

## Contract decisions for implementation review

The tests retain the existing release-v2, realization-v1, edition-preference,
composition-progress, reading-position and entity-page operations. Proposed
additions below are explicit target interfaces, not claims about today's API:

1. Release and realization reads add `sourceEvidence`, an array of exact public
   source references. Each reference retains provider, namespace, external ID,
   source revision (nullable), snapshot/record digests, field locator, record,
   observation and source URL. Source identifiers remain release identifiers;
   an event at a different grain cannot satisfy a native release preference.
   List and detail must agree. Unknown publication year/territory remain null.
2. `releaseTranslator` is an admitted child facet of the existing release group.
   Its translator, language and completeness constraints bind the **same covered
   realization revision**, whose work is the selected Work, inside the **same
   release** as platform and official status. It is not the Work contributor
   facet. The existing `filter-document-v1` request has no `profile` member;
   continuations use `page.continuation`. A child facet at resource scope is a
   typed HTTP 422 refusal, not an empty result.
3. Ordinary Work covers and Character avatars expose role, `sourceEvidence`
   and `rights` alongside the existing image descriptor. `rights` has basis,
   nullable license, evidence reference and obligations. Copyright credit keeps
   a nullable holder and its source; `permittedRole` admits `portrait` as well
   as `cover`. No art license is inferred from database terms. A license which
   is not known remains null. Official source image URLs are expressly allowed
   as the API test boundary. They must identify the exact retained source image,
   have the proper role and accompany usable attribution and rights evidence.
   Native byte delivery is also permitted, with separately pinned rendition
   bytes; transformations need not reproduce the original capture byte for byte.
4. Resource pages expose `mediaDispositions` for admitted public candidates
   which have missing evidence, failed acquisition or forbidden publication.
   They carry resource, role, exact public source reference and a typed reason.
   These test subjects have no successful alternative art, so their ordinary
   image slot is a fallback. Private candidates and withdrawn art cannot leak
   through descriptors or dispositions. A fallback is never successful media.
5. Header and resource page `navigation` maps names/section IDs to a typed
   operation. A resource operation declares GET, exact href, OpenAPI operation
   ID and response profile (null for an unprofiled response). A query operation
   declares POST `/v1/query`, `postV1Query`, the complete executable request and
   `query-v1` response. Existing concrete links must themselves work, including
   the canonical resource ratings path. Legacy query anchors may remain
   discovery anchors; their typed operation supplies the real POST target and
   template-query-v1 body with exact query IRI, revision and roots. Tests never
   turn an anchor into GET or repair a broken link before following it.
6. Facet discovery adds `queryShapes`: ID, state, exact facet definition refs,
   method, href, request profile and maximum page size. Unsupported entries
   include a refusal. A current definition alone does not assert that every
   query placement is executable. The release shape is ready only when the
   same generic request executes for both retained sources.

Reader choice preserves the release pin and, when selecting its text, the exact
realization pin. Platform comes from that release, not UI locale or another
edition. Preference and content-position writes use existing acting-subject,
CAS and idempotency contracts. Return reads, summary and resume must agree.
Private choices and progress never appear in public pages or another Person's
ordinary reader operations. A withdrawn release cannot create a new saved
choice; its exact history may remain readable under existing policy.

## Fixture prerequisite

The typed expectation manifest is
`ReleaseMediaFixture` in
`tests/qa/integration/support/catalogue-release-media.ts`. It is read from
`.temp/qa-fixtures/catalogue/releases-and-media.json`. This is a local test
expectation contract, not a new product endpoint, a source provider adapter or
a replacement backup/restore mechanism. No response is mocked or supplied by
this manifest. Preparation failures occur in `beforeAll`, outside the product
outcome assertions, and must be reported as failed premises.

Before execution, a fixture owner must use the established retained-source and
isolated QA facilities to build one corpus through public commands, retain one
consistent stopped cut, and restore independent copies. Each build and each
restore has the 600,000 ms preparation ceiling; queue admission is separate.
Retain command, revision, source key, backup digest, owner locators and timings.
Bind the restored locators to the current QA run. Restore Account identities
with `restorePersonaRealms`; never retain bearer tokens. The consumer does not
create fixture data, acquire images or import into a live/shared stack.

Required inputs:

- VNDB and a second genuinely retained provider with edition-grained release
  and realization facts. The second provider is selected by available evidence,
  not invented here. Its positive translation/platform/status/coverage case
  must be backed by that source; an insufficient source leaves this prerequisite
  open. Each source needs 3–6 public release expectations so limit=2 traverses
  real continuations, with exact identifiers and source revision/digests.
- Per-source positive selection and witnessed cross-release, cross-coverage,
  wrong-translator and descriptive-event counterexamples. The VNDB negative
  matrix includes zh-Hans/Windows/official/complete. Exact source JSON Pointers,
  raw values or explicit absence, dispositions and normalized native pointers reconcile
  each release's status, platform, date, territory, identifiers and coverage,
  and each realization's language, status and translators. Unknown evidence is
  not filled from a different edition. Fabricated source IDs are forbidden.
- Real retained VNDB cover **and** Character portrait bytes, exact original
  official URLs in retained records, acquisition/source digests, dimensions,
  crop, truthful credit and role/use obligations; plus an ordinary second-source
  cover. Native delivery may additionally retain a distinct rendition digest.
  Database terms and source artwork terms remain separate. Original-contribution
  fixture rights cannot be substituted for source art rights.
- Missing-evidence, failed-acquisition and forbidden-publication subjects; a
  private Work/release/realization/portrait and withdrawn release/image with
  **their actual revisions** and an absent control. Denied pins must otherwise
  be valid for the public Work/language so malformed input cannot prove denial.
- One genuinely published, rights-admitted readable source Work and its exact
  release, realization, Structure occurrence, Chapter and content revision. Its
  position must come from actual public content. This may consume the separate
  Book/content fixture owner's result; imported VN metadata grants no permission
  to manufacture or publish VN text.

The API image test checks the real business-page descriptor and its local
source evidence. It makes no live image request. The browser owner must later
prove that this descriptor reaches the actual page DOM, decodes at the recorded
dimensions/crop and is visible in a screenshot; a detached decode, download,
placeholder or Storybook mock cannot satisfy that obligation.

## Baseline status

The original audit product revision is
`69eac3ceeaf885be70205a70248bc951e9d81cc9`; this is the corrected future pin.
No baseline execution or validation is claimed for this specification. The later
nomination cannot replace the original audit tree retained in state. Identify authored
specification/test/support overlays independently, and record the fixed-wave
revision, restored corpus generation and source snapshot separately. A fixture
unable to run the original revision blocks proof rather than advancing the
product baseline. No baseline run has started, no product assertion has been
reached and no product failure is claimed. The staged files contain no media
captures or two-source command corpus.
The repository's older VNDB dump slice has release facts but lacks the required
cover/portrait evidence and complete second-source/readable fixtures.

Exact blocker: no enrolled command-created producer/restore recipe or compatible
consistent backup supplies the manifest and retained inputs above. Pin the
pristine product baseline separately from the authored tests, prepare/restore
within budget, and then run only the named two-file selection through
`bun scripts/goal/goalctl.ts test`. Record product revision, test revision,
individual failing bodies, the assertion each reached, QA run ID and measured
preparation/restore times. A pending `test.failing` cell is not proof of a
product defect; inspect its body evidence and keep all declarations pending.
