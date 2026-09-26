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
| `offering.ts` | Access-admitted graph create/end/recognize/invalidate commands, independent heads, terminal receipts and reads. |
| `receipt-family.ts` / `outbox-event.ts` | Rights owner graph receipt family and validated relay event mappings. |
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
| `exportScope` | One Content query over at most 256 exact material/head keys and their at most 16 obligations each, plus one Access query over at most 256 exact export targets. |
| `rawRetentionPermitted` | One provider/material lookup and one current service-terms head lookup; absent terms do not create a copyright conclusion, while an explicit `not_supported` result blocks raw retention. |
| `createAdmittedOffering` / `changeAdmittedOffering` | One Access admission and claim; one graph state read, one guarded graph command, one terminal receipt read. |
| `readOffering` | One bounded graph query returning at most two rows for one offering identity. |
| `readOfferingRevision` | One exact graph revision lookup returning at most two rows, with current target read authority checked by the route. |

`rights-use-assessment.test.ts` checks material lookup buffers at 100, 1,000
and 10,000 unrelated materials. This owner records a basis; export, source
refresh, publication and media delivery must consult the current assessment
and Access enforcement fence at their own effect boundaries. Graph rights
offerings use the registered `rights-offering-v1` profile. Their slot key is
the target and instrument hash; offering state and platform recognition retain
separate immutable revision chains. Copy `offering.ts`, `receipt-family.ts`,
`outbox-event.ts` and the route declarations together for another admitted
graph command family.

Main installs the provider-term retention gate on retained source intake and
source acquisition runs. The gate checks the current
`service_terms/raw_retention` assessment for the exact provider and namespace
scope returned by `sourceRetentionScope`. Intake checks before writing retained
bytes; runs preflight every declared namespace and recheck before reading a
frozen capture or fetching, then check again before storing a successful fetch.
A caller can still stage a non-retained observation. Run preflight performs at
most four provider/material lookups for the Open Library profile; capture checks
are bounded by its 81 or 2,048 request limits, with two lookups for each new
successful capture and one per replayed Go proxy response.
Export readers may attach `rightsIdentity` to an exact member's owner-verified
data. It binds the immutable rights material ID and scope to the exact
governance owner, resource, component and revision. Export scope evaluation uses
`rezics:export:<full|excerpt|quotation|evaluation>` and carries only obligations
admitted by the export profile. Missing assessments stay undetermined; they do
not inherit another use's basis.
