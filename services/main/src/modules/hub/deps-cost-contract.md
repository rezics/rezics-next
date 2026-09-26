# Skill dependency lock cost contract

`POST /v1/hub/revisions/{revision}/dependencies` accepts at most 16 resolved
segments. Each segment is read through the selected ecosystem owner and lowered
to one `pkg.lock_segment`; the shared lock owner caps the final artifact list at
256 and writes one `pkg.lock_artifact` per artifact. A Go segment may revalidate
at most 256 retained release captures through its indexed capture owner. A Skill
revision may declare at most 256 package requirements, each mapped at most once.
Thus application work and SQL calls are bounded by `O(S + A + C + R)`, with
`S <= 16`, `A <= 256`, `C <= 256`, and `R <= 256`; request and response bytes are bounded by
the route schema, exact receipt snapshots and the shared lock contract.

Each ecosystem profile remains the resolver/adapter authority. The Hub operation
does not compare versions or merge package identities across segments. The
revision UUID and requirement mappings are included in the lock's canonical
manifest and idempotency digest. Duplicate caller scopes are rejected before owner reads. The operation performs one exact private
lock replay lookup on a same-key retry; new locks use the shared owner's bounded
resolution reads and one transaction for the lock, segment, requirement and
artifact rows.

`tests/qa/unit/hub-deps.test.ts` checks the 16-segment admission boundary,
duplicate scopes and ecosystem-preserving lowering. The shared package-lock API
tests own SQL row/transaction bounds and exact artifact behavior. This check
does not establish deployment capacity or bound the prior ecosystem resolution
operation that supplied each receipt.
