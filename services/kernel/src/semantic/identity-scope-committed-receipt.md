# Committed identity scope receipt resolution

`resolveCommittedIdentityScopeReceipt(pool, {locator, context})` reads an exact
source/scope/registration/capture/revision and completed repair in one released
source-home snapshot. Its `observed` result contains the actual
`identity_epoch_native_commit` partition, epoch, position and transaction ID.
The receiving locator is the **local retained projection** of the pre-arm record:
job, directory transaction ID, page ID and ordinal. It does not claim to verify a
foreign directory's current state.

`holdCommittedIdentityScopeReceipt(tx, pool, {evidence, context})` repeats that
resolution under locks in the supplied genuine command or admitted operational
work-step transaction. It compares the exact native tuple, completion revision,
version, source generation and canonical seal digest. It does not open a connection.
`isHeldCommittedIdentityScopeReceipt(tx, result)` accepts only the private runtime
association in that still-live transaction and original funding episode. Released
observations, copies and ended transaction results cannot satisfy it. None of these
operations is permission or installed Kind/rating authority.

The supported source predicate here is the existing account-owned curated/private
builtin Library capture. Exact current Collection incarnation/generation, account
lifecycle, both native writer fences, completed capture/frontier/native receipt,
committed unreleased registration hold, partition owner, summary state and absence
of active/unresolved work are checked together. Repaired state with zero active
attempts is admitted only with the exact finished completion for the current
revision (or its following ready transition). The complete seal's source, scope and
job must match. The completion and native finish must share the same actual native
transaction version; substituting an unrelated committed transaction is rejected.
Current-transaction versions cannot supply committed provenance. Locks on summary,
partition, native capture, receipt, hold, account, Collection, both fences,
preparation, completion and finish persist through the caller's transaction.

Funding comes only from `identitySourceConsumerLibraryWork` in the actual private
Source maintenance frame. The original Pool, async invocation and immutable
deadline are rechecked before every dispatch. There is no allowance input, new
ledger, independent admission/configuration or permission callback. Every returned
work receipt is cumulative on that original ledger; it must not be settled again
as a child delta. Missing/escaped/expired bindings refuse before dispatch. The
existing Kind preparation episode has no binding to this maintenance frame; it
must not manufacture one from an allowance or a public work-context object.

Literal costs (`identityScopeCommittedReceiptFootprint`) use the eight axes
`candidateKeys, identityMetadataRows, nativeRows, nativePoints, witnessKeys,
statements, bytes, emptySeeks` in that order:

| Operation | Admitted dimensions |
| --- | --- |
| Current capture, including locked form | `(0,0,12,12,0,1,B+512,0)` |
| Exact repair, including locked form | `(0,0,7,7,0,1,B+5120,0)` |
| Released BEGIN, timeout SET, COMMIT, ROLLBACK, each | `(0,0,0,0,0,1,B,0)` |
| Released checkout, existing instrumenter | `(0,0,0,1,0,0,0,0)` |
| Refusal before dispatch | all zero additional work |

`B` is the literal UTF-8 SQL bytes plus serialized parameter-array bytes. The
current query has nine full-key rows and three indexed one-row absence probes;
repair has six full-key rows and one partition point. Seal output is schema-bounded
to 4096 bytes; all other returned fields are bounded scalars. Success, absence,
repeat and dispatched SQL failure pay the same literal bound. A complete released
resolution costs 19 rows, 20 points, six statements and their literal bytes; an
early currentness absence costs 12 rows, 13 points and five statements. The
instrumenter reserves both terminal controls before BEGIN, retains dispatched
charges on failure, and cancels only undispatched controls. Held verification
adds 19 rows/points and two statements; the caller already owns admission and
transaction control. A failed second statement retains the first statement's
charge. Growth in unrelated rows or earlier revisions cannot expand these keys.

This slice remains incomplete at these concrete existing owner boundaries:

* Initial/no-repair registration has no durable source-local association between
  `(partition_no,source_key,scope_id,registration,capture_id,revision)` and the
  committed identity-native transaction. `identity_scope_summary` has no registration
  or ready native transaction column. `register`/capture advancement records an
  identity native registration, but the final `advance` ready transition neither
  retains its transaction nor records an identity native component. The summary's
  later `xmin` cannot recover an earlier transaction. Foreign enrollment receipts
  and Library capture receipts are not that missing association. Initial dispatch
  returns `initial_binding_missing`; it never invents a repair job.
* `library/identity-scope-effects.ts` still returns unavailable from
  `readLibraryScopeEffectsPage` and false from `verifyLibraryScopeEffectsSeal`.
  Thus the real `finish` journey cannot produce the completed repair fixture through
  its ordinary owner yet. Resolution of retained completed native records is
  implemented; tests of the full original writer journey remain unsatisfied.
* Existing observation `register`/`advance`/`finish` command bodies return empty
  event arrays without Core's `noEffect` result; `runCommand` rejects those
  paths with `A command must emit at least one event`. Their bodies are explicitly
  read only for this assignment. No Core change or second writer is installed here.
* Public/explicit output and public population custody require their actual owner's
  native association and private work declaration; this module refuses those
  source dispatches. No Source population/factory/control is added.

Accounts retains origin/formula/time and whole Kind composition, Content retains
native tuple/disclosure and Search retains population/custody. The five audience
closures are separate from this receipt locator. No positive Kind/rating consumer
is activated. Existing observation/type files are unchanged.

Source material read: the current scope types, observation registration/advance/
finish/repair/revalidate bodies, identity native writer/contract/schema, consumer
native receipt reconcilers, binding reconciler, Library custody SQL and effects
adapter; retained `worker/30b4bf6d-0a72-41bd-8282-11169921328c` Kind evidence,
definition catalogue and audience source; and the full exact foreign disposition
`kind-fresh-current1-foreign-operand-20261102.md`. No reference project was named
for this locator surface. Native/unit/growth/full acceptance execution is deferred.
