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
