# Retained digest evidence measurement

The read-only probe is implemented and its available counts passed an isolated
API-seeded proof on 2026-10-12. **The requested two-sided measurement is incomplete.**
The permitted PostgreSQL and public SPARQL connections cannot read the immutable
Work payloads or StructureTree pages. Neither owner persists an exhaustive history
of the relevant digest refusals. The shared development dataset has not been
sampled by this worker; the numbers below describe only the isolated proof.

Run ID: `20261012t020949-5f64f7`. The proof started with zero field-support steps
and zero Structure revision descriptors. Through the product APIs it created a
Work and Recipe composition, retained one source observation, imported two
ingredient lines (creating their conversion and field attachments), and withdrew
one attachment. Authority setup used the existing author-credit QA fixture.
No Source records, observations, conversions or attachments were inserted directly
by the proof. Startup, bootstrap and cleanup took part in its 57.16-second run.

**Row A — source/native field `valueDigest`**

| Measurement | Isolated retained data |
| --- | ---: |
| Supports / steps / attachment steps | 2 / 2 / 2 |
| Examined steps / unexamined steps | 2 / 0 |
| Retained source values measured at certificate JSON pointers | 2 |
| Object / array / scalar values | 0 / 0 / 2 |
| Unavailable source values among examined steps | 0 |
| Source writer digest differs from stored step digest | 0 |
| Certificate digest differs from stored step digest | 0 |
| Source writer digest differs from recursively sorted-key digest | 0 |
| Sorted versus reverse-sorted object-key digest differs | 0 |
| Native adapter/tree pairs examined | 0 |
| Native pair mismatches | Unavailable |
| Retained `not-applied` outcomes / withdrawals | 0 / 1 |
| Historical attach/withdrawal failures or wrong passes attributable to order | Unavailable |

Verdict: **NONE for the two measured QA source values**; the shared-data Row A
verdict is unavailable until the manager runs the probe and obtains exact native
payload access. The JSON's `sourceShapeVerdict` covers source key-order sensitivity;
the requested whole-row `verdict` remains `null`.

An object-valued field **can exist**: `work-metadata-v1#scalar-value` admits
`{kind:"integer",lexical:"0"}`. The proof retained a source object with the order
`{lexical:"0",kind:"integer"}` and compared it with the production
`checkedWorkScalarValue` adapter output: **1 writer-order digest disagreement,
0 sorted-key digest disagreements**. This object was an extra observation field,
not an attached field-support value, and is excluded from the table. The public
Recipe conversion maps ingredient/instruction text slots; this proof did not
exercise an object-valued attachment refusal. That acceptance requirement remains
unproved. Primitive-string semantic-type arrays have no object properties to
reorder; array element order is preserved by this probe.

The [Content migrations](../../../../services/content/migrations/043_source_field_support.sql)
hold field-support steps/certificates, and
[source observations](../../../../services/content/migrations/005_source_intake.sql)
hold raw bytes. Access PostgreSQL is unnecessary for these counts.
[Attachment](../../../../services/main/src/modules/source/support-attach.ts)
checks the native digest before inserting a step, so a rejected attachment leaves
no field-support failure row.
[Withdrawal](../../../../services/main/src/modules/source/withdrawal.ts)
rehash errors can surface as unavailable reads; a withdrawal row does not prove
that its final validating read succeeded. Existing `not-applied` certificates
represent native command refusals and do not count rejected attachments.

**Row B — qualifier-index record equality fingerprint**

| Measurement | Isolated retained data |
| --- | ---: |
| Structure revision descriptors | 2 |
| Sum of revision placement counts | 2 |
| Prepared qualifier roots / complete roots | 0 / 0 |
| Authoritative retained record versions / object or array records | Unavailable |
| Retained-record/current-constructor pairs examined | 0 |
| Unexamined authoritative record pairs | Unavailable |
| Writer/sorted digest differences or retained/constructor disagreements | Unavailable |
| Historical index failures or wrong passes attributable to order | Unavailable |

Verdict: **unavailable**. Descriptor placement counts do not enumerate distinct
immutable records. Assigning `LIVE MISMATCH`, `LATENT` or `NONE` to this row would
require evidence this probe cannot obtain.

[Structure reads](../../../../services/main/src/modules/structure/read.ts) resolve
manifest/page digests through immutable object storage; SPARQL exposes revision
descriptors, not the JSON pages' property order.
[The constructor](../../../../services/main/src/modules/structure/graph.ts)
assembles occurrence objects, while
[qualifier-index checks](../../../../services/main/src/modules/structure/qualifier-index.ts)
compare them with authoritative StructureTree records. Construction/delta
exceptions occur before publication and have no exhaustive PostgreSQL/RDF refusal
journal. [Qualifier-root checkpoints](../../../../services/content/migrations/1705_structure_qualifier_root.sql)
retain preparation progress and completion, not those exceptions. Zero prepared
roots cannot establish absence of object-valued records or prior errors.

**Manager command and operational bounds**

With `CONTENT_DATABASE_URL` and `FUSEKI_QUERY_URL` already supplied in the process
environment, run from the checkout root:

```sh
bun scripts/load/digest-high-rows-probe.ts > .temp/digest-high-rows-measurement.json
```

The [probe](../../../../scripts/load/digest-high-rows-probe.ts) prints one JSON
object. It sends only PostgreSQL `SELECT` and public SPARQL `SELECT`, uses no
Fuseki tokens, and opens PostgreSQL with `default_transaction_read_only=on`.
SQL statements time out after 5 seconds, client queries after 6 seconds, locks
after 1 second, and SPARQL requests after 10 seconds. PostgreSQL connection setup
times out after 5 seconds. Scans use UUID keyset pages of 100, examine at most
10,000 steps, and return at most 65,536 raw bytes per row. Oversize/nonretained
bytes, invalid/missing pointers and unverifiable byte digests increment
`unavailableSourceValues`; cap omissions increment `unexaminedSteps`.

Counts are per immutable support step, including withdrawn attachments, not
deduplicated semantic values. The script preserves array element order and sorts
object keys recursively; reversing those sorted keys supplies a controlled
alternative order. Numeric-looking keys follow JavaScript's serialization rules.
The sorted form is a diagnostic comparison, not a proposed production digest
standard. A source/stored mismatch alone does not attribute its cause to key order.
Steps without a certificate pointer remain unavailable rather than guessing a
pointer from a field name. All native pairs remain explicitly unexamined.

Aggregate counts are subject to the same timeouts; a timeout produces a redacted
error JSON and nonzero exit. Scans do not establish a cross-store snapshot, so
concurrent writes can move totals. Output contains aggregates, not retained values,
principal identities, endpoints or credentials. The public endpoint must end in
`/query` and contain no credentials, query parameters or fragment.

**Verification and remaining work**

The uncommitted wrapper and evidence remain at
`.temp/digest-probe.integration.test.ts` and `.temp/digest-probe-proof.json` in the
worker worktree. The successful command was:

```sh
bun scripts/goal/goalctl.ts test ./.temp/digest-probe.integration.test.ts --timeout 540000
```

It passed **1 test, 31 assertions**, with its self-managed isolated QA stack
`20261012t020949-5f64f7`, and removed that stack's volumes on completion. The normal
integration-tier attempt (`20261012t020747-a1541a`) failed because `.temp` is not a
registered integration path. Two subsequent setup attempts failed before data
preparation: Bun required a `./` prefix, then the stack required `--persistent`
with `--raw-update`. No passing test file was rerun.

`oxlint --type-aware` and `task ast-grep -- scan` passed for the probe.
`task scripts:typecheck` passed with no type errors in 1,843 files. The affected
plan selected only that script check and the documentation check, with no further
test files.
`task docs:check` failed only because this new report is unreachable from
`docs/README.md`; all its local links passed. Linking the report belongs to the
manager because this claim contains only the report and probe.

The manager must run the probe against shared retained data, preserve its JSON,
and allow read-only retrieval of exact immutable manifests/pages to complete both
native comparisons. An object-valued attach/refusal proof also needs an existing
admitted scalar mapping/conversion fixture or an API path that creates one.
Historical attribution additionally needs retained operational logs or an owner
refusal journal; manifests and successful receipts cannot reconstruct refusals
that were never persisted. No owner path or kernel state file was changed.
