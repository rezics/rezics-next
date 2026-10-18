# Shared audit corpus preparation

The producer in [audit-corpus.ts](../../scripts/qa/fixtures/audit-corpus.ts)
prepares one command-created catalogue and projects the existing consumer
contracts in [audit-corpus-contract.ts](../../tests/qa/fixtures/audit-corpus-contract.ts).
It uses RetainedSources, the dataset selector/importer, persona fixture APIs and
the stopped-owner backup owner. It does not acquire sources, refresh shared
imports, or replace any of the original 113 native Work identities.

The [consumer prerequisite table](audit-corpus-prerequisites.md) records all
current prove files, named cases, actual parser/readiness contracts, historical
setup failures and unresolved owner interfaces. It establishes no ready corpus
or product outcome.

Preparation and product proof are separate phases. A wave build may run only
the stack-free unit, type, lint and guard checks. The commands below which start
owners require the manager's explicit preparation/prove phase.

## Inputs and offline inspection

Keep the private recipe, original binding ledger, backup and source captures in
this worktree's `.temp/`. Pinned evidence may also live in `tests/fixtures/`.
Inputs cannot resolve through a symlink into another checkout. No source data,
credentials, retained receipts or backup belong in a commit.

The recipe has format `audit-corpus-recipe-v1`; its TypeScript interface is the
input contract. It contains:

- `sourceRoot`: the byte-identical frozen dataset tree. All snapshot file and
  logical digests, record digests and qualified edge occurrences are checked
  against the independent [import matrix](../../tests/qa/fixtures/catalogue/import-outcomes.json),
  including snapshots not selected for an import stage.
- `originals`: a file/SHA-256 pin for an `audit-original-bindings-v1` ledger.
  Its backup pin names the existing consistent stopped catalogue backup; its
  113 unique bindings give source key, resource, mainVersion, revision and the
  exact supported read path/JSON pointers. No title search reconstructs them.
  `personas` retains the original `RetainedPersonaRealm`, including its actual
  operator and OAuth client bindings. Preparation signs in normally through
  `retainedOperator`/`retainedAuth`; it cannot designate another first platform
  administrator on a restored catalogue.
- `imports`: deterministic root selections with explicit budgets and mapper
  IDs/revisions. A bounded selected view currently blocks on the importer
  owner seam; it must never become a fabricated snapshot or `maxRecords` prefix.
- `evidence`: exact source record bytes/pointers, qualified public-domain or
  licensed text quotes, real cover/portrait bytes with source URL, credit,
  rights evidence and obligations, or clearly original fixture contributions.
  Original author prose cannot qualify a public-domain Book/Recipe fact.
- `realms`, `emptyIdentityRealm`, `grants`: at least two public author Realms
  and a private Realm, an Account-only negative identity and explicit supported
  fixture authority. The Access owner returns the retained grant and
  representation IDs. An operator label confers no import mandate.
- `stages`: ordered dependencies and public Main commands. Each mutation has
  evidence IDs, an expected successful status and a unique retained replay key.
  Commands stop on the first unexpected status or transport failure. There is
  no blind replay after an unknown result.
- `readiness`: exact identity reads, including public 200 and concealed/missing
  404 controls. They never execute a query under proof to construct its oracle.
- `manifests`: one projection fragment per existing consumer. Native identities
  and generation tokens must have been observed in original bindings or
  successful owner receipts. Source expectations remain independently pinned.

Projection values may be JSON or strict operators:

```json
{"$audit":"ref","from":"command:create-book","pointer":"/answer/work"}
```

`concat` joins string values; `tail` obtains a native IRI's short ID. Available
bindings are `originals`, `source`, `realms`, `identities` (including `/empty`),
`controls`, `authority`, `import:<snapshot>`, `command:<id>`, `receipt:<id>`, `preparation` and
`restore`, `read:<id>` and `read:<phase>:<id>`. Successful readiness checks bind
their real response, including observed generation tokens; each restored copy
replaces the current read binding after checking its identity. The receipt ledger
retains the actual original-binding and readiness responses for every phase.
Failed/unexecuted commands have no binding. `controls` contains
fresh unknown IDs, admitted to provenance only after a genuine 404 read.
Runtime addresses, product revisions, measured timings, backup digest and
command-ledger custody are producer-owned projection fields.

`receipt:<id>` is the existing search consumer's `{path, sha256}` evidence
shape: a mode-0600 file containing the same single successful command receipt
as JSON. For example, a record's `evidence` can reference the whole binding with
`{"$audit":"ref","from":"receipt:create-book","pointer":""}`. These pins
join retained-source integrity checks. The multi-command JSONL ledger remains
the contextual/information receipt ledger; it is not parsed as single JSON.
The public-domain projection supplies its backup as a checkout-relative `.temp/`
path, as required by that consumer, retaining the same physical cut.

```sh
task goal -- prepare-audit inspect .temp/audit-corpus/recipe.json
```

Inspection is read-only and never obtains a QA slot or starts owners. It reports
`ready: false` even when prerequisites pass: inspection is not preparation.
Missing original bindings, source files or source qualifications fail closed.
No distributable ready recipe has been checked in: source text, nutrition,
substitution and media rights premises require genuine retained evidence.
An omitted recipe argument uses `REZICS_AUDIT_CORPUS_RECIPE`, or the canonical
`.temp/audit-corpus/recipe.json` path. The preflight repair command uses that same
selection and is executable without substituting a placeholder argument.

## Explicit preparation and one backup

Once the owner prerequisites and inputs exist, run from the worktree:

```sh
task goal -- prepare-audit prepare .temp/audit-corpus/recipe.json
```

This admitted command restores an isolated copy of the original backup, applies
current owner migrations, prepares actual personas, creates the Account-only
control through the identity fixture's existing stage, verifies all 113 original
bindings, obtains exact fixture grants, imports isolated byte-identical copies
and runs the ordered stages. It verifies original identities and read readiness
again before closing API writers.

The same command calls `retainStoppedOwnerBackup` once with `purpose: corpus`,
`resumeSource: false` and `stopCorpusSourcePostgres`. It retains Postgres, Fuseki,
RustFS and local object stores at the same stopped cut. It then calls
`restoreCatalogueBackup` on that cut for migrations and an independent readiness
round trip. There is no separate raw storage/SQL/RDF preparation command.

The entire active preparation, including source inspection, initial restore, API stages, stopped
cut, round trip and source cleanup, must fit **600 seconds**. Only host admission
wait is excluded. Each proof restore has its own existing 600-second preparation
budget. No larger producer deadline is introduced. Measured build/round-trip and
restore/startup/readiness times are retained; a build that exceeds budget cannot
publish a ready source.
`FixtureWorkBudget.includeElapsedWork` charges inspection and runtime setup to
the retained-source lifecycle once per budget, including cached verification.

RetainedSources owns source keys, compatibility, integrity, publication and read
leases under `.temp/audit-corpus/sources/`. Failed-attempt JSONL evidence remains
in `.temp/audit-corpus/attempts/`, outside disposable pending publication trees.
HTTP failures retain their real status/body; transport failures have no HTTP
answer. Neither becomes a product assertion failure or a successful receipt.
Successful command JSON evidence stays alongside its attempt ledger, outside
disposable publication trees; it remains checksummed if later stages fail.

## Independent proof restores

After explicit preparation, select a proof from `auditProofFiles`:

```sh
REZICS_AUDIT_CORPUS_RECIPE=.temp/audit-corpus/recipe.json \
  bun scripts/goal/goalctl.ts test tests/qa/integration/outcomes/catalogue/import-fidelity.test.ts
```

The QA preflight verifies the retained source without building it. The isolated
file harness holds its source read lease for the whole proof. Imports, context,
releases and information receive a fresh owner project and measured readiness
before the test starts. Public-domain, search, identity and author helpers restore
their own independent copy from the same stopped cut. None uses a mutable shared
catalogue or an unrelated bootstrapped outer stack.

Environment-aware helpers receive a private per-run manifest. Fixed-path helpers
receive a symlink to that immutable manifest while a per-consumer lease prevents
concurrent publication. An unmanaged existing fixed-path evidence file is
preserved and blocks publication; it is never overwritten. Setup/restore failures
are classified as environment failures before product assertions. The harness
releases the copy and source/publication leases when the proof ends.

The original baseline product is `69eac3ceeaf885be70205a70248bc951e9d81cc9`,
as corrected by the wave's audit specifications and consumer owners. The import,
information and public-domain fixture pins now agree with it.
`auditBaselineBlockers()` checks their actual pins and refuses an incompatible
premise; this producer does not relabel fixtures or alter independent assertions.
The manager must still establish a compatible fixture/test overlay. Product
revision, test overlay, fixed wave, corpus generation and frozen source identity
are separate facts.

This producer does not introduce a baseline-overlay or proof receipt owner.
The manager must use the existing pinned proof workflow, retain baseline failures
and candidate results separately, and report assertions actually reached.
Producing a source does not certify any pending product outcome.

## Remaining owner interfaces

The `auditOwnerPrerequisites` export is the executable handoff:

- The importer must accept the selector's `DatasetRootSelection` together with
  its immutable parent and manifest, retaining original record/edge/image indexes
  and exact journal native bindings. The current prefix API is insufficient.
- Native mapper owners must register executable fields, relations, credits,
  releases and media `DatasetNativeMapper` implementations with stable
  `id`/`revision` and actual receipt/coverage/occurrence/source generation data.
  The current producer registers only the existing captured-media mapper.
  Relations, credits and releases adapters now exist on the wave; field
  projection is a pure plan. Credit adoption bindings and release source/native
  correspondences must come from their actual owning receipts before wiring
  those adapters. Their presence alone does not establish source admission.
- Source custodians must supply the original 113-binding backup, frozen source
  trees, qualified Book/chapter/Recipe nutrition/substitution quotes and licensed
  cover/portrait evidence. Missing facts remain unknown.

The consumer authors' [import handoff](../goals/audit-remediation-20261019/import-corpus-handoff.md)
and [information handoff](../goals/audit-remediation-20261019/information-outcomes.md)
remain authoritative. In particular, the original baseline's storage owner must
accept the retained backup: a current-wave backup with newer migrations, model
or compose configuration cannot stand in for it. Unavailable refresh generation
tokens and required native identities block preparation; proposed coverage,
release or relation results are still tested independently in the proof bodies.

Connect these interfaces in the single producer; do not add per-proof seeds,
pretend owner receipts, same-name replacement records or synthetic media. A
blocked inspection/preparation retains its reason and cannot publish manifests.
