# Context and Statement qualification notes

The executable [CTX01–CTX10 inventory](../../scripts/qa/cases/classification.ts)
owns the scenarios and required results. Qualification needs real graph-owned
Context/Realm selections, Access-owned private selections, current authority,
retained receipts and storage behavior. Shape-only or mock-only checks cannot
establish cross-service recovery, disclosure or capacity.

The 2026-09-26 Statement replacement retained all ten case IDs. Earlier runs
through the v1 Application/Sense profile remain evidence for that profile, not
automatic proof of the Statement schema or aggregate reads. The selected
`20260925t183629-db4f16` integration run established CTX02 local rejection
without inherited Global fallback on v1. The selected
`20260925t194147-c1de17` run established CTX03 fail-closed graph-read faults on
v1. Neither tested arbitrary loss of all local Application triples or all shared
Context obligations. Preserve exact owner inputs, receipts, builds and failures
when reviewing replacement evidence; re-evaluate qualified coverage before
claiming a complete case.
