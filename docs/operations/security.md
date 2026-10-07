# Security and disclosure boundaries

Fuseki and owner databases are private dependencies. Product clients call
Main or Account; only Main and admitted maintenance tools reach raw graph
endpoints. Named graphs organize data but grant no authority. Keep the
[raw-update S0 drill](installation.md) on an isolated listener; it has no
product authentication. Remote owner calls require authenticated private
transport and distinct credentials.

Main and Access admit typed commands and scoped reads. A client cannot submit
arbitrary SPARQL, graph names, `SERVICE` targets, file paths or administrative
operations. Account owns credentials and sessions. A PostgreSQL decision and a
TDB2 write require receipts and reconciliation across their separate commits;
see the [command protocol](../contracts/commands.md).

Apply current disclosure and revocation to exact revisions, search candidates,
snippets, counts, exports and deliveries. A text hit or RDF join alone does not
prove current authority. Denial or authority outage never becomes permission.
Keep suspect search unavailable until its generation is qualified. Redact
credentials, account mappings, private queries and matched literals from logs.

During an incident, fence affected admission, preserve receipts and restore
only after authority and erasure frontiers reconcile. The
[erasure runbook](erasure.md) distinguishes hidden content, retained copies and
physical destruction.

## One disclosure and enforcement policy

Decision 9, product manager under maintainer delegation, 2026-09-29.
Server evaluation combines suitability, interaction blocks (distinct from mute),
privacy, spoilers by consumption position, Realm/platform jurisdiction and
revocation. It applies to every read and delivery, including originals, search,
counts, previews, notifications, exports, offline copies and AI context.

The reason is that derivatives can disclose the very information a direct read
withholds. [OWASP's authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
supports checking every request; REZICS extends that check across owner-produced
derivatives and delivery. [Suitability](../contracts/classification-judgments.md#suitability-and-disclosure)
owns audience gates. Server revocation fences future delivery; it cannot promise
to recall independent copies already delivered, as
[client synchronization](../contracts/client-synchronization.md) records.

## Qualification evidence, 2026-10-07

The earlier G-744 review at `d1cba62ea061a5c861a2bce1c7684522ed32e05b`
identified missing deadline/escalation alerts and uploader safety mail. Those
capabilities are implemented by G-917/G-918, with
[deadline integration](../../tests/qa/integration/g-917-safety-alerts.test.ts)
and [uploader-mail integration](../../tests/qa/integration/g-918-safety-mail.test.ts).
The later deadline/suppression repair `9a082844f8e2` passed seventeen integration
and fourteen owner checks: cancelled or unconfirmed effects cannot retire a due
case, and identical-copy suppression commits with its original restriction.
Named responders and real mail delivery remain operator prerequisites.

The G-1294 source review at `12186858a0f3b9c2fad0edcb28c25eb294574373`
found four High issues and one Medium issue. Each repair has targeted evidence:

| Finding | Repair and verification |
| --- | --- |
| Recovery enrollment bypassed the second factor | `96bf4db360df`: every enrollment consumes normal session-bound step-up; [real recovery proof](../../services/account/tests/recovery-step-up.integration.test.ts) includes first/spent enrollment, expiry and session binding. |
| Snapshot acquisition could reach private addresses before edit authority | `1154b205ebc7`: checked numeric public destinations, pinned sockets and authority before acquisition/storage; [network proof](../../services/main/tests/web-snapshot-network.test.ts) and [authority proof](../../services/main/tests/web-snapshot-network-authority.test.ts). |
| OAuth backchannel logout could dispatch to unresolved/private destinations | `c037159f4364`: all metadata write boundaries refuse the unsupported URI, legacy rows cannot dispatch and discovery marks it unsupported; [provider/session integration](../../services/account/tests/oauth-backchannel.integration.test.ts). |
| Read-only consent could mutate personal reading records | Account `07ac9df29782` and enforcement `f4724506c`: eighteen mutations require `library:write`, fifteen reads keep `work:read`; [owner proof](../../services/main/tests/library-write-scope.test.ts) and [integration](../../tests/qa/integration/library-write-scope.test.ts) passed at the enforcement pin. |
| Upload bodies buffered before authentication/reservation/size checks | `3957f02adb3a`: live bearer and reservation before streamed reads, byte cap and cancellation deadline; [intake proof](../../services/main/tests/media-stream-intake.test.ts). |

H1–H4 are fixed and verified; that does not substitute for whole-release
regression. The OCI context omission is fixed. Image qualification at
`e140c7c42385` passed three live tests/fifty-five assertions in112seconds,
including building all five backend roles twice and actual readiness, refusal,
recovery and native image decoding. Later model/native changes need targeted
current-image qualification; the pinned evidence cannot qualify those bytes.

The accepted limits remain the maintainer's narrowed market/feature policy and
lack of age assurance: assessed age-gated targets are withheld from everyone,
and staff retain separate correction authority. Independent delivered copies
cannot be recalled. Deployed edge configuration, off-host staffing, vendor
scanner enrollment, real mail and container dependency vulnerabilities require
release/operator evidence. Suppression/erasure restore and populated backup/
compaction qualification remain incomplete; the program owns whole-main
regression and the manager's final security pass.
