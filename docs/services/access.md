# Access service

## Owner and interfaces

Implement [identity/access](../contracts/identity-and-access.md) over private
PostgreSQL ownership. APIs cover context admission, check/bulk-check, role/group/
binding lifecycle, membership activation, representation, impact planning and
revocation/recovery. Pure shared permission definitions generate Rust/TypeScript
contracts; services do not maintain independent registries.

## Evaluation pipeline

Verify principal/session/client assertions; resolve the explicitly selected
authority subject and complete representation path; apply target rights and role/
member-set conditions; intersect credential/consent/installation/assignment ceilings;
apply hard principal/resource restrictions; return allowed/denied/unavailable with
decision identity and freshness. Batch target evaluation without mixing contexts.

Bindings and recipient expansions use selective scope/subject/target indexes and
bounded hierarchy walks. Cache by all relevant authority generations and scope.
Protected commands bind the decision to operation/target/expected state. Privileged
scope fences coordinate strong revocation with already admitted work.

## Mutations and cross-owner references

Local grant/membership/role updates are atomic with receipts/outbox. Register
remote Agent/Resource roots from verified owner operations; missing/deleted/retired
roots remain explicit and cannot mint authority. Provisioning and enrollment stay
pending until every required owner receipt exists. Do not claim remote FKs.

Role/group edits stage their effective expansion, validate assignment ceilings
and independent approvals, then recheck generations at activation. Institutional
assignments and dependent delegation have different lifetime rules. Recovery
retains original paths, one-use approvals and decision evidence.

## Failure and qualification

Access failure denies protected admission while independently public content may
continue under an explicit policy. Test competing grants, stale impact previews,
group cycles, ceiling changes, dependent revocation, last-controller protection,
account enforcement and restoration. Optional specialized evaluation engines must
prove these semantics and freshness before replacing a read path.
