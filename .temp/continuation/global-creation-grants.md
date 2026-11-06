---
goal: accounts
manager: accounts
---

# Authorize Space and Realm creation grants on the Global Context

The platform governance account cannot grant `space:create` or `realm:create` on the Global Context. The grant
command refuses both at authorization, while `subject:create` on the same resource is accepted. The grant is
`POST /v1/grants` with the governance credential, resource `{ route: 0, id: 00000000-0000-8000-8000-000000000000 }`
(the Global Context, which is also the platform root anchor used by `parentCreationAuthorization`), and
`valid: '(,)'`. The refusal happens in `authorize`, not in preparation; the grant command reports it as `403 forbidden`.

Access documents the cause. `services/kernel/src/access/README.md` states that a point Resource infers its type only
when the action has exactly one registered type, and that point actions without one exact target type keep the SQL
evaluator "until `Resource` carries that operand". `space:create` (`community.space`) and `realm:create`
(`community.realm`) each have one type, so the Global Context is evaluated as a Space or Realm resource, where the
`platform.governance` role does not apply. `subject:create` has two types and keeps the SQL evaluator, which is why
it passes. Community requires these authorities on the Global Context: `services/kernel/src/community/README.md`
states that creating a Space requires `space:create` on the Global Context through `parentCreationAuthorization`,
and that creating a Realm uses `realm:create` on the Global Context with `space:manage` on the host.

Effect on tests: the native content fixture
(`services/kernel/test/content/support/native-system.ts`) makes exactly these grants before any case. Every case in
`specs/content-user-cases-outcomes.test.ts` (19 on base) therefore fails in `beforeEach` with
`Setup POST https://content.test/v1/grants failed (403)`. The same grant is needed by the composed provisioning of
the private Realm and of the reader's Space. Aligning the fixture's action catalogue with the composed production
catalogue (`NATIVE_CONTAINER_ACTIONS`) does not change the refusal, so the cause is in policy evaluation, not in the
fixture's catalogue.

Requested: give a creation check against the Global Context the parent's type, so the platform governance role
authorizes `space:create` and `realm:create` there. The owner may choose the mechanism the Access README anticipates
(a `Resource` type operand, or a parent-typed creation check passed by `parentCreationAuthorization`). The grant
command, the creation path and the community route declarations must agree on it. No content test or fixture should
be weakened to pass.

Acceptance to finish the content row once this lands:

- `bun run --cwd services/kernel check test/content/user-cases-outcomes.test.ts` runs its 19 cases past provisioning.
- `bun run --cwd services/kernel check test/content/late-board-revocation-point-reads.test.ts` passes. It holds thread
  head and post head at the reaction-totals read, and exact revision at the disclosure seam.
- Subject discussions and author activity still need native late-revocation coverage. The composed binding holds them
  through `content.disclosureBarrier`; nothing native covers them yet.

Already landed on the content side: thread head, post head and the thread post page disclose again after reaction
totals (`services/kernel/src/content/routes.ts`), and `content.disclosureBarrier` is the composed timing seam
(`services/kernel/src/content/reads.ts`).

## Second base blocker: standing fixture Access construction

`services/kernel/test/access/standing-fixture.ts` builds Access with resource roles that name an unmounted action
(`fixture.unmounted` → `unmounted:action`). The policy catalogue compile now refuses that
(`TypeError: Invalid native Access policy catalogue: unknown-resource-action`, raised from
`compileNativePolicyCatalogue` through `createAccess` at `standing-fixture.ts:141`). Every test built on the standing
fixture therefore fails before its first case on base: `boards-http`, `subject-threads-http`, `board-hot-http`,
`author-item-reads`, `author-item-public-views`, and the native late-revocation point-read test
(`services/kernel/test/content/late-board-revocation-point-reads.test.ts`). These are the receiving controls for the
content read changes, so none of them can verify those changes until the fixture constructs Access again.

The owner decides whether the refusal or the fixture role is wrong; this part does not weaken either.

## Owner decision 52451 (received)

Accounts122 retains Global parent and live authorization, so the Space and Realm creation grant above belongs to that
owner. Community660535a9 owns Space witness stale-reference provenance, forward migration and regeneration, and the
populated Realm revision and replay repair. Those are received normally in native composed acceptance; this branch
does not patch them. The full Realm acceptance remains 0/16, and a narrow provisioning pass does not accept this outcome.

What this branch still owns, and what it has not yet proved:

- Native late-revocation coverage: anonymous takedown for thread head, post head and exact revision
  (`test/content/late-board-revocation-point-reads.test.ts`), and anonymous takedown for the newest board page and
  thread post pages, first and continuation (`test/content/late-board-revocation-pages.test.ts`).
- Protected read-grant revocation for the same families still needs an account fixture. The standing fixture
  cannot construct Access on this base (see the second blocker above). The composed user-case suite covers it once
  Accounts122 and Community660535a9 land their parts.
- Hot and active board pages are not covered natively yet; they need board rank rows.
- The composed `specs/content-user-cases-outcomes.test.ts` (19 cases) still fails at provisioning until Accounts122's
  Global authorization lands.

## Third base blocker: anonymous visibility of seeded content and member reaction authority

Check 78b0bbff ran the landing set on the final code (`a94948e022`). Five files failed:

- `late-board-revocation-point-reads` and `late-board-revocation-pages`: the first anonymous baseline read of a seeded
  published thread, post, revision or Board page returns 404, before any late change. Their seed now matches Subject
  threads: a visible concept for the Board and a subject reference on each revision.
- `board-hot-http`: hot and active Board pages return 404 for seeded Boards.
- `reaction-counts-http`: member reaction writes return 403, and an anonymous post-page read returns 404 at its root.
- `subject-threads-http`: anonymous Subject listings of seeded threads return an empty list.

The changed routes (thread head, post head and the thread post page) run their first read before any changed code, and
the Subject, Board page and reaction-write paths are unchanged, so these are not regressions from the read-ordering fix.
A comparison run of the same landing set on the base kernel source ran, but aborted at the typecheck: the contract pins
and the new test imports name types that base source does not have, so it produced no test evidence. What settles it:
a base run that drops those files and reproduces the same failures, or Access and Accounts establishing the public
floor for seeded anonymous reads and member `reaction:set` authority on this base. Then the landing set must pass.
