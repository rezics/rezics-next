# Continue reviewed provider vote delivery

## Goal content

The committed Content slice exposes `createVoteCommands(...).readVoteReview(actor, questionId, targetId)`. It returns the disclosed standard question, the existing counted-reader observation, and the exact recursively frozen `VoteReviewGuard`. It does not complete guarded vote effects.

Continue the sole `createVoteCommands.putVoteOutcome` writer. In the fresh command body, after current authorization and receipt lookup and before no-op, cleanup, vote writes, events, or side effects, call `createQuestionVoteAdmission.prepare/admit` and Semantic's actual identity participant on the original authorized executor transaction. Compare the full normalized guard there. Preserve existing unconditional behavior, receipt digest/replay semantics, matching no-op component behavior, exact guard/key across uncertain retry, and the foreign logical-home deferral.

Bind only the actual Semantic producer callable and reviewed mapping/control operand. It must hold the exact requested/terminal mapping, source epochs, and persisted `control_group`/`control_partition` publication components through COMMIT or ROLLBACK, with every competing mapping, publication, and movement writer using the same owner fence. Confirm account, question, requested Subject, canonical Subject, and every required control home against the executor's logical home from genuine provider operands. Do not substitute physical co-residency, a copied identity query, or a fresh command-time mapping observation.

The base had no installed provider call to `readVoteReview`; AniList still reported `counted_vote_review_missing`, and Bangumi still reported conditional admission unavailable. Deliver the review export and encoding to the existing VNDB, Bangumi, MAL, and AniList receivers through their owning work. Do not add another provider writer or worker.

Add the minimum native cases for successful guarded set/clear, stale and unavailable zero effects, authorization-before-receipt, replay after state changes, different-guard conflict, uncertain same-input retry, and native competing question/lifecycle/identity/publication/vote schedules. Controller retains the original concurrency, independent 256/1024/4096 growth, all-pool, installed-root, and merge acceptance.

## Manager content

The integrated Semantic source at the inspected base exported no commit-held Rating identity participant. `identity-rating-admission.ts` sampled the resolved terminal and requested/canonical-home epochs, while its SQL read `semantic.subject` and `semantic.redirect`; it did not retain or lock the reviewed mapping's persisted control publication tuple. `QuestionVoteAdmission` already rejects a question whose logical partition differs from the account executor. This leaves a structural third-home counterexample: source and canonical epochs can match at the executor while the persisted identity control home is elsewhere, and current admission neither observes nor fences that control. No actual provider caller operands were installed in this base, so their native logical-home coverage remains unproven.

Smallest missing owner contract: Semantic's existing participant must accept the producer's frozen review and admit exact mapping, epoch, and persisted-control evidence on the original same-home executor transaction, held through completion by all owning writers. Once its callable and genuine provider heads are integrated, Content can bind the supported one-home path and return exact foreign-home evidence without weakening successful same-home delivery.

Estimate: one Semantic owner attempt (about 4–6 hours) and two Content integration attempts (about 8–12 hours total), excluding controller-owned native/growth execution. Re-estimate after the provider callers expose their actual logical homes.
