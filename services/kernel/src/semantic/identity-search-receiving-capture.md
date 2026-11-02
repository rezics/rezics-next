# Search receiving capture identity

The original pre-commit planner traverses both complete copy and source-role
prefixes for the genuine original and distinct native transactions. A shared
transaction is traversed once. The deferred capture consumes that exact armed
event in the same database transaction.

An armed event binds each ordered prefix with a rolling SHA256 identity as well
as its count. Replacing an account, role or origin after planning cannot reuse a
same-sized reservation. The deferred body verifies both complete identities and
raises `identity_receiving_capture_original_identity_changed` on a mismatch.
All attempted locator writes, copies, effect receipts, provenance, pending events
and native commit/write-basis rows roll back together; earlier committed origins
remain intact. Same-origin replay still compares the same genuine identities.

Decision: bind role identities as well as cardinalities, because equal counts do
not establish that the original prepaid capture is still current.

The identities do not supply Source support, original-copy completeness or
erasure authority. Those continue to come from actual native rows, indexed
exhaustion, current original provenance and existing seal/custody guards. No
caller-supplied hash or delivery position is accepted.

## Cost

The existing deferred physical reservation remains separate from the planner's
instrumented SQL and its additional bookkeeping. This increment preserves that
physical subtotal and its existing exact tests. It does not repair the existing
five-base-seek schedule or establish the whole Source-core 24-point/two-seek fit.

Every event prepays 1536 bookkeeping bytes, previously 1024. The added 512 covers
two 64-byte arm operands, their pending-row storage and deferred projection, and
two 64-byte rolling states. The arm statement separately prepays one native row,
one native point, one statement and 1024 bytes including SQL, operands and result;
its other four dimensions are zero. No additional SQL, index, lock or FK is
introduced by the identities, and the pending table has no new index or trigger.

Every visited role, including a repeat or subsequently refused role, prepays 1024
bookkeeping bytes, previously 512. The added 512 covers both native and planner
hashing: each uses at most 160 UTF8 input bytes, 32 binary digest bytes and 64 hex
result bytes. UUIDs have fixed lengths and legal roles have at most 12 ASCII
bytes. Hashing has no additional candidate keys, native rows, identity metadata
rows, native points, witness keys, statements or empty seeks. The bounded rolling
state adds no retained array or result-dependent second traversal. Both bodies
order by the underlying indexed keys, independently of the bounded role
projection. The deferred body checks the prepaid count and legal role before
hashing each visited row.

These are irreversible debits in the existing original child before arming and
deferred dispatch. Failed funding, repeated events, refusal and rollback retain
the attempted-work charges; this operation grants no allowance or refill.

The native regression exercises equal-count replacement in both genuine origins
after the real planner and before the actual native commit. The existing 1/10/100
copy campaign and funding, provenance, sealed replay and atomic rollback oracles
remain required. Their isolated generous fixture does not prove Source-core fit.
