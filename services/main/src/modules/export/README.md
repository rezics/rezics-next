# Export owner, preparatory slice

`schema.ts` declares the Content 121 rows. `receipt-family.ts` reserves the
`export.create` terminal family for the Access sealer. `planner.ts` accepts only members read
and verified by their owners, then assigns stable ordinals, preserves exact value
lexical forms and owner-local positions, records losses, and derives a conservative
license scope through `LicenseScopeHook`. It does not read an owner, authorize a
request, write the Content tables, or seal an Access admission. Do not pass a
request body directly to `planExport` as `VerifiedExportMember`.

The owner reader must independently verify the exact revision and digest, current
disclosure and erasure state, and the applicable use assessment for this export.
An `unmapped` grain needs a member-linked residual. Unknown or conflicting bases
stay uncertain; a prohibited basis blocks sealing. A later G-051 rights adapter
implements `LicenseScopeHook` from exact rights records and restrictions. Separate
source positions represent repeated occurrences; the plan makes no global
cross-owner snapshot claim.

## Cost contract

One plan admits at most 256 members, 1,024 residuals, 256 bases and 1 MiB of
canonical output, with a maximum JSON depth of 16 and 16,384 traversed nodes.
Work is `O(M + R + B + N log N)` for members, residuals, basis links and sorted
object keys; `work` records member, residual, basis, basis-link and serialized-byte counts.
This bound covers only in-process planning. Owner reads, authorization, SQL
inserts, graph calls and recovery need their own measured bounds. The focused
test checks the admitted member ceiling and exact value preservation; it does
not claim database or remote-call complexity qualification.

## API template still required

`POST /v1/exports` needs a real Access export admission and Content-owned terminal
receipt before its `admission_id` and `authority_epoch` can seal Content 121.
The current export tables have no Content owner position or receipt-action
registration, so a scoped follow-up migration is needed. It also needs
owner readers for external releases and sealed Structure manifests before
LIVE10 and COMP08 can be completed. FACT05 needs current private-evidence
disclosure and method calibration against labeled evaluation data. No complete
case declaration is made from this preparatory slice.
