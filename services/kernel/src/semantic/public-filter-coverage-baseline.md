# Baseline enrollment receiving

Baseline receiving snapshots its binding and enrollment before the first checkout; owner verification and receiver adoption use that same tuple.

`beginPublicFilterCoverageBaseline` pins the original registration generation before native home enrollment.
`adoptPublicFilterCoverageBaseline` first verifies the exact committed native enrollment and creation checkpoint,
releases that checkout, then adopts its immutable receipt under the registration lock. The two transactions do
not overlap. A caller changing its objects while either checkout is pending cannot change the registration,
bootstrap, definition, native home, epoch, positions, account revisions or receipt used by the receiver.

Only fixed, own data fields on plain objects are accepted. Nested registration data is copied separately;
accessors, proxies, coercible positions and out-of-domain scalars refuse before checkout. The snapshot does not
enumerate extra caller keys. Readonly TypeScript annotations alone do not establish this lifetime guarantee.
The creation-checkpoint name uses a dependency-free shared helper, retaining the Accounts export and exact
encoding. Baseline and creation-window imports no longer initialize unrelated command or HTTP workflows.

The receipt digest identifies an enrollment; the existing owner row and checkpoint checks establish committed
provenance. Enrollment still leaves coverage behind. It grants neither a repair ACK nor ready population,
including an empty home. Existing replay checks, predecessor chaining, registration locking, epoch invalidation
and transaction rollback retain their meaning. The immutable preparation cut is not renewed by adoption.

## Cost and verification

Snapshotting adds no SQL, native key, checkout, lock, root, seek or owner round. It reads seven fixed fields for
generation pinning and seventeen for adoption, including the nested registration. Immutable strings and bigint
scalars are retained by value; arbitrary caller objects are not retained. This bounded validation does not
provide funding, increase an allowance or establish the complete Source phase quote. Existing database work,
controls, failure, rollback and cleanup still belong in the original all-axis declaration.

The focused transaction-boundary tests cover mutation between owner commit and receiver checkout, mutation
before the initial checkout, retained behind state, non-overlapping checkout disposal and rejection without
executing caller accessors or coercions. They do not replace native population, atomicity or funding acceptance.
