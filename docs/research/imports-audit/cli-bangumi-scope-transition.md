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
native reference object and hash. The frozen test remains unchanged. The corrected managed command passed
at code revision `fbdb5fa5425f4ed8918a23e794015e80485b7d35`: one named native child above, 1 pass,
0 fail, 1,094 assertions, no skips or todos. Raw execution log:
`.temp/goal/checks/worker-check-2026-10-30T09-52-13.907Z-3838f521.log`.
Line 59 contains the actual observation JSON; lines 62–78 record the pass and managed exit status 0.
The child ran in the real Auth/API/registered-worker world, not a protocol double.

All five invocations reported `bangumi@3`; persisted native record revisions are `unversioned`.
The actual catalogue is `https://rezics.com/catalogue/rezics` version `1.0.0`, bundle digest
`sha256:5ce80804c4cc09983190130049f7883ebdb2f628cd30db0f774d5889d23fa0bd`.
The observed target baseline digests and complete source counts are:

| Input               | Present | Skipped | Book 71001 baseline digest                                         |
| ------------------- | ------- | ------- | ------------------------------------------------------------------ |
| Initial Book        | 5       | 2       | `6bb4282aea90e295d9e76e091501b07a433c628b5aff31d05e461851e3be9fda` |
| Ignored music       | 5       | 3       | `e0812490d20c8a73e5fad6d6e7438175f88b15a6fa8389611abcaf8e699ad523` |
| Ignored live action | 5       | 3       | `b7833616079047d549ceb444a246e5a4a1991360e405546cce367e7063233c08` |
| Returned Book       | 5       | 2       | `23c81c03223656f265479c61018d16e452854af4dadf711e4e3f5f14f83975ce` |

Unchanged reopen retained the returned baseline and source generation 4 with no public writes.
There were nine original immutable receipts, two actual retraction receipts and two fresh returned
candidates. The target subject remained `01a18c46-5fe9-76de-bc0c-58cd15e185cf`; its original create
receipt has transaction `01a18c46-5fe7-73b3-bfc0-db53abc12e01`, partition 1420, epoch 1, position 1.
The retraction receipt transactions are `01a18c46-6450-74d2-8edc-fa1dad7079bd` and
`01a18c46-6490-731b-8e4e-4869dfef5443`, at positions 7 and 8 in that partition and epoch.
They retract candidate IDs `67d0a3dc-2fdc-8b57-86fe-58cddd6a6530` and
`d3a36224-d3f0-8023-9a26-58cd77e5dbd5`. Returned IDs are
`0e82d918-66ce-8651-b18a-58cd33d6934d` and `8472d33d-9bba-816c-be20-58cd6afb5006`.
The independent editor selection retained candidate `9beddbe7-a8b9-8e8f-aaee-58cd3efb1641`.
The raw JSON retains complete receipt keys, request/response bodies and source rows behind these anchors.

Before native admission, edited-file formatting and the explicit local importer compiler passed
(`node_modules/.bin/bun check --no-script -p services/importer/tsconfig.json`, 147 files).
The two local children passed with 25 assertions:

- `ordinary Bangumi registration discards ignored fields without visiting them across serialized transitions`
- `ordinary Bangumi CLI seals the whole transition input before any Auth or public request`

This is an isolated connected native pass. No main/promotion, all-provider, root typecheck or new native
growth evidence is claimed; canonical/derived growth suites remain unchanged.

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
