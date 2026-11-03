# Realm asset collection growth operation binding

This report binds the native Realm asset collection growth scenario to the existing collector and its owner Cost
contract. It does not change the collector, retention, page limit, worker schedule, authorization or account-erasure
participant.

## Authority and decision

- Owner: [Content Cost, Realm asset collection and account erasure](../../services/kernel/src/content/README.md#cost-realm-asset-collection-and-account-erasure).
- Base: `c968558f1f20e21ca88ac8e7b26754a3fd642d7a` on the clean retained `dev` source.
- Decision: selected Realm assets and the permanent claim use native HTTP; unrelated media and retained history are
  seeded outside observation, while collector pages, refusal, retry and storage effects stay inside capture.

## Operations under observation

The private test fixture provisions the Realm through Content HTTP, reserves an icon and banner through the native
Realm media endpoint, completes each upload through the website credential, and waits for the registered image effect
to publish its derivatives. A separate icon is selected in a native Realm settings revision and then cleared in a
later native revision. The test reads both revision records and confirms the media row still carries its permanent
Realm claim after the current presentation is empty.

At each measured sample, the fixed eligible page contains two real available assets: one unclaimed icon and one
unclaimed banner. The production `content.collection.hourly` schedule selects the page, writes its fence, deletes the
real storage prefixes, finishes the media rows, and emits the terminal collection events. The first selected prefix
fails one physical delete; while the fence is committed and bytes remain, the test replays the original completion
request and records its refusal through the same physical observer. The registered workflow then retries the page and
must acknowledge terminal completion. The older settings revision's claimed icon and physical objects must remain.

Unrelated media pressure uses available young rows and two fixed variants. The retained-history axis adds unrelated
Realm homes whose real-shaped media claim rows and settings revisions are seeded outside observation. These rows are
not selected. Axes run independently; media pressure is removed and vacuumed before the next axis. The history axis
runs last because its revision records are immutable. Each measured operation fixes one partition, one Realm route,
two selected media, source bytes, derivative shape, object-prefix shape and the production batch limit of 100.

## Acceptance binding

- Test: `services/kernel/test/content/growth-realm-asset-collection.test.ts`.
- Private fixture: `services/kernel/test/content/support/growth-realm-asset-collection-fixture.ts`.
- Command: `bun run --cwd services/kernel check test/content/growth-realm-asset-collection.test.ts`.
- Growth scales: 256, 1024 and 4096 for same-home media, other-home media, and retained claim/settings history,
  each grown independently.
- Cost bound: constant rows and statements, logarithmic buffers for the existing page size; the shared physical
  observer records actual statements, rows, buffers, relations and captured runner work.
- Reached assertions: native reservation and completion, native old-revision claim and current clear, candidate page
  size, pending fence before deletion, refused completion replay, retry, terminal workflow result, physical prefix
  deletion, one fence and finish receipt per collected row, and unchanged claimed media plus its stored objects.

## Observations

The committed source revision was `3c03f8182a`. The focused command was attempted once:
`bun run --cwd services/kernel check test/content/growth-realm-asset-collection.test.ts`.

The check stopped in its schema-consistency preflight before the test file started. Its reached failure was:
`error: Schema dump differs from db/library/schema.sql.` The diagnostic reported expected object
`native_public_output_binding` and actual object `members_preparation`, and said
`Checked source commit/tree: UNKNOWN (no retained source provenance at this boundary).` No test assertion, selected
collector operation, or physical effect was reached. The test's temporary measurement report was therefore not
created. This change does not edit schema files; the base command was not rerun, so this preflight mismatch is not
attributed to either source revision here.

The fixture is bound to one native-created Realm route and one collector partition, two unclaimed selected media
items (one icon and one banner), plus one icon whose old settings revision permanently claims it after a later native
clear. The test records runtime IDs and revision numbers only after setup; they were unavailable because setup did not
start. The independent axes and requested scales are below; no scale measurement was observed:

| Independent axis | 256 | 1024 | 4096 |
| --- | --- | --- | --- |
| Same-home available media | Not reached | Not reached | Not reached |
| Other-home available media | Not reached | Not reached | Not reached |
| Retained claim/settings history | Not reached | Not reached | Not reached |

Actual statements, rows, buffers, relation access paths, refusal/retry runner work, and physical deletion results are
unavailable for all nine samples. The controller defers the frozen acceptance check until integration.

## Execution limits

The measurement includes registered Content work and the refused replay's application-database statements through the
instrumented pool. Setup HTTP, image upload/effect publication, pressure seeding, cleanup, vacuum/analyze and the
separate Auth fixture database are outside the measured operation. The test must not be used as account-erasure
participant acceptance; that remains with its existing owner test. The required kernel typecheck command,
`bun run --cwd services/kernel typecheck`, also exited with code 70 before compilation: `remote-check: infrastructure
failure` reported an absolute preparation deadline during source-artifact publication. These are execution limits;
neither command produced a source-level diagnostic for this change.
