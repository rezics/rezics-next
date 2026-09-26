# Rights use assessment owner (Content PostgreSQL)

The `rights.material`, `rights.use_assessment`, `rights.use_assessment_head`
and `rights.obligation` tables come from Content migration 080. The assessment
row is an immutable idempotency receipt; the head is a compare-and-swap pointer
for one material, family, use and scope. Complaint decisions and restrictions
reuse Access governance cases, decisions and enforcement fences.

| File | Role |
| --- | --- |
| `schema.ts` | Typed declarations checked against migration 080. |
| `store.ts` | Access assessor grant, exact material identity, append/CAS, current use evaluation. |
| `../../routes/rights.ts` | Write/read API profiles and Account bearer check. |
| `tests/qa/integration/rights-use-assessment.test.ts` | Real owner/API denial, replay, use separation, CAS and index checks. |

Copy `store.ts` and `../../routes/rights.ts` for another Content-local rights
record family. Keep the independent use key, expected head, immutable receipt,
Access authority check and SQL constraint mapping. An unknown result does not
become permission. A prior wiki assessment is not a basis for export or paid
reuse. Service terms and data rights remain separate families.

## Cost contract

| Operation | Bound |
| --- | --- |
| `assess` | One Access grant lookup, one indexed material lookup, one head lock and at most 16 obligation inserts. |
| `evaluate` | One Access grant lookup, one indexed material/head lookup and at most 16 obligation rows. |

`rights-use-assessment.test.ts` checks material lookup buffers at 100, 1,000
and 10,000 unrelated materials. This owner records a basis; export, source
refresh, publication and media delivery must consult the current assessment
and Access enforcement fence at their own effect boundaries. Graph rights
offerings remain blocked on G-071 registration.
