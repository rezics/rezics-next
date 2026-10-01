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

## Launch review, 2026-10-01

G-744 reviewed launch source at
`d1cba62ea061a5c861a2bce1c7684522ed32e05b`: Account enrollment, recovery,
OAuth, first-party sessions and mail suppression; Main admission and disclosure
for editorial proposals and wiki publication; media clearance, public reports,
appeals and preservation; MCP dispatch and wiki-toolkit credentials; Worker
proxies, release image inputs and production configuration checks. The existing
G-897/G-904 and G-898 disclosure regressions passed, as did the Account SR-1/SR-3
and G-731 regressions. This is a source review with targeted disposable-stack
checks, not release-image qualification. The OCI build failed because its
context omitted the wiki-toolkit workspace; a fresh release-image bootstrap
therefore could not be reviewed.

Readiness remains blocked by G744-H1 (no automatic NCII deadline alert or
absent-responder escalation) and G744-M1 (media enforcement creates a private
party notice but does not queue the affected uploader's safety email). Their
executable counterexamples are in the
[finding tests](../../tests/qa/integration/g-744-findings.test.ts); the
[safety drills](../../tests/qa/fault-recovery/g-744-safety.test.ts) leave missing
capabilities explicitly unfinished. Neither finding is an accepted residual risk.

The accepted launch limits remain the maintainer's narrowed market/feature
policy and lack of age assurance: assessed age-gated targets are withheld from
everyone, and staff retain separate correction authority. Off-service copies
already delivered cannot be recalled. No conclusion here covers deployed edge
configuration, off-host inbox staffing, vendor scanner enrollment or container
dependency vulnerabilities; those need release and operator evidence. Changes
merged after the reviewed source, including merge/unmerge, wiki deltas and
library import, require the manager's final pass.
