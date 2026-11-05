# Subject reaction read boundary growth

Decision: measure own-slot reads only with a signed account, keep public counts on the existing `/reactions` route, and bind the zero-work internal batch to `withReactionCounts([])` rather than an HTTP request or the 1–100-id subject-total helper.

## Operation binding

| Capture              | Selected operation                                                                                                        | Expected result                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Empty own slot       | Authenticated `GET /v1/subjects/:id/reaction` for an account with no slot while another account has a registered reaction | `200 { kind: null }`; anonymous access remains `401`                                |
| Zero count           | Public `GET /v1/subjects/:id/reactions` after a real set and clear have been applied by the registered reaction effect    | `200` with `counts: []`; the response has no viewer slot                            |
| Empty internal batch | `withReactionCounts(dependencies, [], deadline)` with no selected targets                                                 | Empty items and freshness `null`, with zero database rows, buffers and statements   |
| Denied read          | Public-count route for a visible subject with a real Access denial for the current account                                | `404` with no count disclosure; the Access lookup stays inside the measured request |

The selected subjects are created by the mounted subject command in the native reaction fixture. Selected slot and
count state comes from mounted `PUT` and `DELETE` reaction commands, followed by the registered content reaction
effect, its completion barrier and idempotent replay. Setup writes, subject selection, effect completion, replay and
reader completion remain separate phases. No selected result is seeded into reaction tables.

Each capture keeps its selected subject ID and selected partition set fixed and runs independently against two
pressure axes at 64, 512 and 4096 rows. The unrelated-population axis adds unrelated visible subjects, reaction slots,
subject reactors and count projections across the same four target partitions. The retained-history axis adds only
unrelated `core.receipt` records in one fixed existing actor partition. Fixture pressure is inserted before the
measured operation. The public-count and denied-read captures use the mounted route without pagination; the internal
empty batch is not a request and does not call `readSubjectReactionCounts`, whose contract requires 1–100 IDs.

The shared growth observer classifies native rows, buffers and all statements for each actual operation. HTTP denial
assertions require the Access resource-denial path; route reads retain the owning Cost bounds of constant rows,
logarithmic buffers and constant statements. The empty batch requires exact zero cost. Existing controls also pin
public count privacy, another account's private slot, anonymous own-slot denial, and current suspension denial.
Merged subject IDs retain the mounted routes' current `308` redirect behavior, already asserted by the frozen
`subject-reactions-http.test.ts` suite; this capture does not measure merge work.

## Execution record

- Source base inspected: `c968558f1f20e21ca88ac8e7b26754a3fd642d7a`.
- Acceptance command: `bun run --cwd services/kernel check test/content/growth-subject-reaction-boundaries.test.ts`.
- Fixtures: the new private boundary fixture, the unchanged native `reaction-relay-convergence-fixture.ts`, and the shared growth observer/access-path classifier.
- Reached assertions and three-scale observations: not executed in this attempt. The current controller defers native acceptance; authored expectations are not measured passes.
- Execution limits: no native, browser or acceptance check was launched here; the controller runs the bound acceptance after integration.
