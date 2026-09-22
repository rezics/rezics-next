# Security, disclosure and erasure

## Trust boundaries

Separate Account origins/cookies, service identities, private DB credentials,
public graph/query surfaces and untrusted execution. Authenticate service calls
with audience-bound credentials and key rotation. Clients cannot select privileged
Fluree identities, datasets, raw storage capabilities or unrestricted admin queries.

Input validation covers typed IDs, lossless values, JSON-LD context acquisition,
URL/redirect/DNS constraints, archive paths, payload size and execution budgets.
Source text, templates, Skills, model output and tool responses are data; only
explicit admitted operations grant network, filesystem, credential or execution use.

## Disclosure and revocation

Enforce current resource and exact-content disclosure on APIs, history, search
match text, snippets, facets, graph paths, exports, media and notifications. Caches
and candidate handles bind security/context generations. Access denial and Access
unavailability never become allow. Strong stop-after-revocation effects use the
admission/drain fence protocol, not token expiry alone.

## Erasure

Distinguish retraction, hidden publication, tombstone, retention expiry and physical
erasure. Fluree history retains retracted facts, so an erasure plan inventories
graph history, raw captures, object payloads, search derivatives, logs, replicas
and backups. Minimize sensitive immutable data; key destruction applies only to
encrypted material covered by that key, not plaintext indexes or other copies.

Advance a durable erasure frontier, stop new disclosure, execute bounded deletion/
redaction, verify coverage and carry the frontier through restore/replay. Retained
legal/security records follow their declared policy and access; do not invent
legal retention guarantees from architecture. [Privacy policy](../../legal/privacy-policy.md)
remains the published legal owner.
