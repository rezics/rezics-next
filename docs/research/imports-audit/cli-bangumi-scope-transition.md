# Ordinary Bangumi CLI scope transition

The frozen [native outcome](../../../services/kernel/test/imports/cli-bangumi-scope-transition.test.ts)
connects the ordinary `runImportCli` caller to one `openApiRuntime`, the existing `identitySupport`,
`openApiObserver` and actual `mediaBoundary`. It does not depend on another slice's new fixture.
The scenario has one child:
`ordinary Bangumi CLI preserves complete membership and native identity across supported ignored and supported input transitions`.

Run from the worktree root:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-bangumi-scope-transition.test.ts
```

## Input and observations

Five synthetic metadata-only JSONL native envelopes have distinct positive Bangumi IDs: Book 71001,
animation 71002, game 71004, music 71003 and live action 71006. These are controlled fixtures, not
claims about live provider records. Book 71001 changes to music 3, then live action 6, then returns
to Book 1 with a revised title. Its native key never changes. Every run uses the existing
`bangumi@3` converter and `unversioned` native record revision. No summary, cover, type mapping,
eligibility policy or converter revision is added.

Ignored envelopes carry invalid supported-field shapes, unsafe image URLs and private markers in
discarded fields. A complementary local registration test uses throwing getters to prove these
fields are not visited, including after serialization. The native fixture independently checks
that none of these markers reaches retained SQLite payload rows, public request/response bodies
or observed native results. It supplies no user writing to a product command.

An ES256 account key is provisioned through actual staged, approved and applied credential effects.
Its private JWK and SQLite state live on tmpfs with mode 0600. CLI fetches route to the actual Auth
host and application replay handler. No bearer or private key is logged. Acquisition must seal the
complete supplied input before Auth or public effects. The fixture observes real `Importer`,
`RunStore` and `RecordBindings` objects; it never substitutes a remote result.

The first ignored transition retracts exactly the two owned Book candidates through public batch
requests. The next ignored transition writes nothing. Native claims, subjects, original candidate
bytes, bootstrap terms/revision, local bootstrap journals and old immutable receipts are compared
before and after. A separately proposed, accepted and adopted editor title remains selected in
its own Context. Returned candidates are independently retrieved, cited, current-revision
proposals with fresh IDs under the same claim. Unchanged reopen performs no public write.

The native log emits actual converter/bundle revisions and digest, source rows/digests, captured
credential-free HTTP bytes, native receipt rows and media boundary observations. No growth series
or PostgreSQL block count is inferred. Existing counted ceilings and canonical/derived suites
remain unchanged. The connected scenario does not close other provider journeys or promotion.

## Execution status

The first managed run at `2b4b453934` reached real returned proposals, then failed in fixture glue:
TypeScript rejected a possibly undefined map lookup, and the citation comparison omitted the public
reference's additional `hash` field. The actual reply contained the expected Bangumi URL and native
reference hash `f5470599226c2052b8afe7b4b8852b150dd4df35dc2797a5c6fbfa90649e2c8f`.
Its one named child failed after 910 assertions; this is fixture failure, not a production reconciliation
red or a native acceptance pass. Raw witness:
`.temp/goal/checks/worker-check-2026-10-30T08-52-08.129Z-24a9dfca.log`.

The fixture now narrows the actual previous command and checks citation parts while retaining the
native reference object and hash. The frozen test remains unchanged. Native acceptance of the corrected
fixture is pending; a helper or local registration pass is not native acceptance.

## Source inspection and decisions

Read the ordinary CLI, importer reconciliation, run store, record bindings, source registration,
Bangumi converter and the existing native API/identity/media exports. Read the existing
`provider-cli-native` and `disappearance-cli-native` journeys for public proposal and editor flows.
Read the reference Bangumi server at `1997713eafc51487cbea705b37011442f35539fa`:
`internal/model/subject_type.go` and `openapi/components/subject_v0.yaml` under
`.reference/shelves/bangumi-server`. Only native type/field declarations are used; no code is copied.

The five records are synthetic so this transition adds no source acquisition or licensing claim.
The independent selection is a real editor-owned candidate, rather than an imported candidate
selected by an editor. Original candidate rows remain immutable while their retraction status is
read separately through the public candidate API. Existing production reconciliation already
expresses this journey; no production defect is presumed merely to create an implementation diff.
