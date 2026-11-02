# Committed identity scope receipts

`resolveCommittedIdentityScopeReceipt(pool, {locator, context})` resolves an exact
source/scope/registration/capture/revision in a released source-home snapshot. It
returns `observed` evidence containing the actual `identity_epoch_native_commit`
partition, epoch, position and transaction ID. The receiving locator identifies
the local retained pre-arm projection by job, directory transaction, page and
ordinal. It is not verification of a foreign directory's current state.

`holdCommittedIdentityScopeReceipt(tx, pool, {evidence, context})` repeats resolution
under the supplied genuine command or admitted operational work-step transaction's
locks. It compares the exact native tuple, completion revision/version, source
generation and seal digest. It opens no connection. The locks survive through the
caller's commit or rollback. `isHeldCommittedIdentityScopeReceipt(tx, result)`
requires the private runtime association, the same live transaction and original
funding episode. Observations, copies, expired episodes and released results cannot
satisfy it. These operations are receipt production and currentness verification,
not permission, installed Kind/rating authority or five audience closures.

The supported sources are account-owned curated/private builtin Library captures.
The currentness query checks Collection incarnation/generation, account lifecycle,
both writer fences, owner epoch/movement, complete capture/frontier/native receipt,
committed unreleased registration hold, exact summary state and absence of active
attempts, consumer withdrawal fences and unresolved enrollment work. The verifier
holds the summary, partition, Collection, account, capture, receipt, hold and both
fences, plus every resolved association and native component, including the
initial capture-completion pair inside its bounded existence probe. All SQL stays
in that source home. Foreign receiving/capture work completes before the writer
takes its source-home transaction.

Locator validation uses the native UUID route and schema scalar domains before
routing or SQL admission. Invalid routes, owner epochs, oversized scope/source
values and noncanonical generations refuse as `source_binding` without IO or an
additional debit. This prevents malformed locators from throwing at the route
boundary or reaching PostgreSQL casts. It creates no source or permission evidence.

## Durable writer association

The forward migration adds only `identity_scope_native_association`, with primary
key `(partition_no,source_key,scope_id,registration,capture_id,revision,phase)`.
It stores the complete source identity and genuine native transaction, epoch,
position and purpose. Finish rows additionally retain job/epoch, attempt and
completion version. A foreign key resolves the native transaction in the same
partition. There is no migration backfill.

The exported internal writer operations are:

- `prepayIdentityScopeNativeAssociation(pool, deadline)` debits the genuine current
  private Source maintenance original before starting the narrow command. It returns
  an opaque one-command admission, never receipt evidence. The effective command
  deadline is the lesser of the supplied deadline and the immutable original.
- `bindIdentityScopeNativeAssociation(tx, admission)` checks that original's Pool,
  live async episode/deadline and the actual executor transaction. Reuse on a second
  transaction, a copied admission or an escaped callback refuses. Attributed
  commands refuse because their extra basis/receipt writes are outside this
  platform-command package.
- `recordIdentityScopeNativeAssociation(tx, admission, key, phase, binding?)` queues
  the existing executor native component and the association in that same command.
  Its return is the genuine additive closed `IDENTITY_SCOPE_NATIVE_ASSOCIATED`
  domain event. It is not a precommit receipt. Binding carries the exact job for
  completion work or dependency for enrollment work.

The insert locks the exact summary itself. It requires a real same-transaction
summary, completion or exact enrollment write. Finish additionally requires the
same-transaction finished attempt and complete sealed completion, exact capture,
attempt and revision. The executor's native callback precedes association insertion;
an original-liveness guard precedes that callback. The event, association and native
component commit atomically. Failure or expiry rolls them all back. No source
command position, newly read foreign receipt, summary `xmin` or hold `xmin` is used
to invent a native component. Matching transaction versions only validate already
retained native components.

Hooks are confined to registration, capture/enrollment progression, ready
advancement and finish/progress command results. A ready advancement now creates
its own actual registration-purpose native component. Unchanged registration and
ready replay use `noEffect`, retain the exact association and revalidate the
existing hold without rewriting it. Actual writes emit their association event;
they are never labeled `noEffect`. No Core/runner change or unrelated event is used.
The four reserved consumer accounting functions and scope types remain unchanged.

Initial resolution requires both the exact ready association and its preceding
complete capture association/native component. No repair job is fabricated. An
initial locator refuses if this registration has any retained receiving attempt.
Historical ready metadata without genuine associations stays unverified even after
read/replay. Completed repair resolution preserves the existing full-key durable
attempt/completion/native-finish binding, including transaction-version equality,
exact sealed source/scope/job, pre-arm transaction and prepared native component.
Those records already constitute a genuine repaired association; no backfill is
needed or performed. If the scope subsequently becomes ready, resolution also
requires its exact new ready association and returns that ready native component,
while retaining the actual completion revision/version/seal. Repair state itself
returns the actual finish component. Locked verification repeats all those checks.

## Literal local costs

All costs use the eight axes `(candidateKeys, identityMetadataRows, nativeRows,
nativePoints, witnessKeys, statements, bytes, emptySeeks)`. SQL hit, absence,
repeat and dispatched failure pay the same point bound. Unrelated registrations,
captures, revisions and jobs do not widen the keyed probes.

| Resolver operation                                  | Dimensions                |
| --------------------------------------------------- | ------------------------- |
| Current capture, released or locked                 | `(0,0,12,12,0,1,B+512,0)` |
| Ready association, released or locked               | `(0,0,7,7,0,1,B+512,0)`   |
| Exact completed repair, released or locked          | `(0,0,7,7,0,1,B+5120,0)`  |
| Released BEGIN, timeout SET, COMMIT, ROLLBACK, each | `(0,0,0,0,0,1,B,0)`       |
| Released checkout                                   | `(0,0,0,1,0,0,0,0)`       |
| Missing binding/source refusal before dispatch      | zero additional work      |

`B` is literal UTF-8 SQL plus serialized parameter-array bytes. Currentness has
nine keyed rows and three one-row absence probes. Ready has four keyed rows,
two exact capture-completion points and one attempt absence probe, prepaid even
when optional probes are skipped. Repair has six keyed rows and one partition
point; seal output is schema-bounded to 4096 bytes. Initial or repair-state released
resolution costs 19 rows, 20 points and six statements. Ready repaired resolution
costs 26 rows, 27 points and seven statements. Held verification costs the same
query rows/points without checkout or transaction controls. The existing
instrumenter reserves terminal alternatives before BEGIN and retains dispatched
charges on failure. Caller transaction controls remain the caller's responsibility.

`identityScopeNativeAssociationPrices` publishes additive writer bounds before IO:

| Added writer operation                                                                                | Dimensions                           |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Executor native insert, partition point plus component write                                          | `(0,0,2,2,0,1,S_native+320,0)`       |
| Association, including optional exact completion/attempt/forward points, conflict/write and native FK | `(0,0,8,8,0,1,S_association+6720,0)` |
| Event fence, partition update plus one outbox event                                                   | `(0,0,2,2,0,1,S_fence+2112,0)`       |
| Time point, checkout and seven control statements                                                     | `(0,0,1,2,0,7,C,0)`                  |

`S` is the corresponding imported SQL literal's byte length. Parameter/output
maxima are included explicitly. `C` is the literal time SQL, BEGIN, lock timeout,
two maximally bounded statement timeouts, COMMIT, ROLLBACK and a 128-byte scalar
parameter/output envelope. This fixed command package charges 13 rows, 14 points,
10 statements and the sum of those bytes on every admission, including unchanged
replay, refusal after admission, failure and rollback. Both terminal alternatives
remain charged. There is no success/absence refund, balance reset, new allowance,
configuration, independent parent or caller-provided callback authority. Each
released hook uses the existing single-command-attempt executor profile: a failed
fence or serialization conflict returns after rollback; it cannot start another
unfunded checkout or command before the admission is rebound. Existing
observation/foreign producer bodies keep their own original accounting; this
additive package cannot stand in for their whole-parent funding.

Writer deadlines must be safe integer milliseconds within the original immutable
deadline. This also bounds the literal timeout representation charged above.

## Remaining foreign operands and verification

Both resolver and writer use `identitySourceConsumerLibraryWork` from the actual
private Source maintenance frame; neither creates one. An unbound ordinary caller
must supply its real original private dispatch grant to enter these operations.
A historical capture allowance, public work object or fresh configured maintenance
frame created inside a producer is not that grant. Missing or expired binding
refuses only the affected dispatch; the storage, native association, resolution and
locking bodies are implemented independently.

Library alone owns positive `readLibraryScopeEffectsPage` and
`verifyLibraryScopeEffectsSeal`. Their current native bodies read the retained
sealed plan and exact native seal receipt. The final verifier also requires
`currentLibraryIdentityWork(tx)`: a repaired dispatch lacking that original
private binding continues to refuse. There is no unconditional positive seal
and this slice adds no replacement Library page/seal producer. Public population
and explicit public-output custody require their owners' native evidence and private admission;
this resolver continues to refuse those source kinds. Accounts owns origin/formula/
time and whole Kind composition, Content owns native tuple/disclosure, and Search
owns native population/custody. Local scope receipts supply none of those closures.

Original acceptance bytes are preserved. Appended native regressions cover funded
real initial registration, atomic event/native association, ready replay without
backfill, exact finish binding, ready advancement, native substitution, original
Pool/episode/deadline admission, rollback/expired callback, held-versus-released
currentness, capture-component lock retention, platform-only writer admission
and bounded revision growth. Native/unit/growth/full acceptance are
unrun under the current launch policy. The permitted Kernel compiler result is
reported in the delivery summary; it is not native or whole-feature proof.

Source material read includes current scope types and registration/advance/finish/
repair/revalidation bodies; identity epoch native writer/contract/schema and native
receipt reconcilers; Library custody and effects adapter; retained Kind scope,
evidence, catalogue and audience source; the full foreign operand disposition;
and both the Semantic native writer decision and Commerce regional consent. No
external reference project is prescribed for this surface.

The migration has its required `-- migrate:up` and forward-only `-- migrate:down`
blocks; existing migrations are unchanged by this continuation. The supported
foreground Kernel compiler can normalize this module's schema snapshot with
`bun run --cwd services/kernel typecheck --emit-schema=semantic` using its existing
placement and compiler database. Compiler success alone does not establish native
acceptance, source custody, a foreign dispatch grant or an audience closure.
