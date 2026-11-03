# Exact pinned Realm rules disclosure growth

This operation binding covers the existing native `readExactPublishedRules` dependency and its composition in
`readCommunityPresentations`. Authority remains the [Content community presentation contract](../../services/kernel/src/content/README.md#community-presentation)
and its [Cost bound](../../services/kernel/src/content/README.md#cost-community-presentation-read), under
[Content Done when and Acceptance](../goals/content.md). It introduces no production behavior or promotion claim.

The retained source inspected for this binding is `c968558f1f20e21ca88ac8e7b26754a3fd642d7a`, initially clean.
Its functional `community/presentation.test.ts` and `community/home-presentation.test.ts` exercise native settings,
immutable pins, concealment and unavailable optional dependencies. `community/growth-realm.test.ts` measures Realm
commands/reads rather than this rules dependency. The premise is missing focused native growth acceptance, not a
previously executed product failure.

Decision: use a fixed two-Realm presentation page (one adopted pin, one unset), repeat the selected Realm identity,
and measure refusals in the same fixed operation; neither population axis changes the selected page.

## Native operation

The private fixture uses `createNativeContentSystem` with default write budgets. That fixture constructs production
Access, real Auth credentials and the real Kernel. Bootstrap definitions precede ordinary subject, Space, Realm,
board-scheme, board and published-thread HTTP commands. Native `createPost` commands establish the selected ancestry
with actual creation admission, grants, receipts, write bases and events. Authorized `PATCH /v1/realms/{id}` selects
the actual post/revision through ordinary CAS settings validation. Later native authoring changes the post head
without changing the selected rules. No selected publication, claim, revision or authority is SQL-authored.

The production Content work module and registered effects use the observed pool, through the existing inline
registration helper. Exact disclosure is synchronous and requires no runner job, projection catch-up, member-count
initialization or media work. Terminal completion is the awaited native read return. Registered effects do not
supply a replacement successful rules result. Required runner work for this operation is zero; the test asserts
zero background statements. Setup and module registration are outside observation. Receipt replay is separately
exercised on the real settings command, including refusal of a new stale-head command.

The functional case checks a natively authored 33-key chain and exactly 65,536 canonical UTF-8 bytes, rejects
65,537-byte rules, and retains the existing 100-reference/100-distinct-Realm ceilings. Missing revision, wrong post
and wrong Realm produce no document. Unset rules stay `none`; optional dependency errors become `unavailable`.
Real commands between the first committed rules snapshot and the final snapshot change the Realm, Space or
current post head. The transition hook forwards native SQL and decisions without supplying source or authorization
facts. Changed signatures withhold the first result. Protected read loss and concealed ancestry disclose no rules
bytes. The next ordinary read must use current native evidence.

## Independent pressure and bounds

Each axis starts in a separate isolated native fixture. The fixed selected chain has three posts and a 4,096-byte
immutable document; later unadopted bytes, selected IDs, parent depth, route/partition count and page size remain
fixed at all scales. Pressure templates come from another natively authored Realm/thread. SQL seeding is confined
to unrelated pressure outside observation; shared fixtures and runtime contracts remain unchanged. The unrelated
pressure graph uses the selected post, Realm and board routes. Retained history grows that private graph without
changing its heads or adding ancestors or siblings to the selected thread.

| Axis | 256 | 1,024 | 4,096 | Grown records |
| --- | --- | --- | --- | --- |
| Population | 256 neighbours | 1,024 neighbours | 4,096 neighbours | Same-route independent Space/Realm heads and revisions, boards, threads, posts, revisions and owner grants |
| Retained history | 256 histories | 1,024 histories | 4,096 histories | Unselected post revisions, Realm/Space revisions, expired role grants, receipts, outbox and write bases; current heads stay fixed |

The existing `checkGrowth` observer captures actual native statements, examined rows, shared hit/read buffers,
request/response bytes and background work, and uses the shared physical classifier with the owner's constant
rows/statements and logarithmic blocks bounds. It keeps its normal warmups, repetitions, telemetry admission,
settling, slack and planner behavior. Full key batches and two source/final rounds bound the reader; no body or
retained-history scan is permitted. `assertGrowthAccessPaths` checks every selected domain relation across accepted
repetitions. Mismatch/missing reads, oversized-reference admission and unavailable dependency composition remain
inside the measured operation, including refused work. A separate native capture compares repeated Realm IDs with
unique Realm IDs and requires equal statements/rows and exactly two rules-body statements.

## Execution boundary

From the worktree root, the focused landing command is:

```sh
bun run --cwd services/kernel check test/content/growth-realm-exact-rules.test.ts
```

The workspace compiler command is `bun run --cwd services/kernel typecheck`. Controller admission owns native,
browser and integration acceptance launch. An authored test, queued command or infrastructure exit supplies no
reached assertion or three-scale observation. Runtime growth output binds the execution's exact Git revision,
fixtures, actual statements and three scales; only a completed native run can populate observed measurements.
This document declares the binding and expected bounds rather than inventing measurements for deferred execution.

If native execution reaches a behavior failure, the proposed owning seam is Content's exact rules reader and its
native source/final signature or parent-disclosure batch, or Community's settings admission for a pin-validation
failure. This slice authorizes no implementation repair there. Infrastructure failures remain separate from
reached assertions; no successful growth or promotion result follows from compiler success.

Sources read for the binding: the linked Content sections and Goal clauses; the three existing community test
files above; exact rules preparation/body SQL, `reads.ts`'s exact reader and snapshot protocol; community presentation
composition; native fixture/HTTP authoring and effect-registration helpers; shared growth capture, classifier,
seeding and access-path helpers; relevant Content and Community row shapes. No external reference source is named
by this contract.
