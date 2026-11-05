# Native Realm member-count mutation growth

This binds the community [Maintain count with native membership Cost row](../../services/kernel/src/community/README.md#current-native-realm-member-count)
to [focused native acceptance](../../services/kernel/test/community/growth-realm-member-count-maintenance.test.ts).
The contract remains constant work per actual changed row and logarithmic indexed blocks. Initialization,
backfill, count reads and interval role/authority selection retain their separate owners and allowances.

Decision: use the membership close producer's supported same-T empty-interval deletion for physical-delete
coverage; historical cleanup and account erasure must use their own registered producer, never test SQL.

## Operation and fixture

The [private fixture](../../services/kernel/test/community/support/growth-realm-member-count-maintenance-fixture.ts)
composes `createProductionAccess`, `createRealmMembership`, `createAccountsWorkModule`, `communityWorkModule`,
`composeWork` and the HTTP kernel. Tokens pass through the production authenticator. Durable restoration reads
the real operation and the fixture's exact per-account consent scopes. There is no permissive Access adapter,
injected committed event, substitute count command or new participant. Both the kernel and SDK pools belong to
the shared growth observer. Setup/population SQL and snapshot assertions use its unmeasured admin connection.

Each measured cycle holds one selected Realm and actor fixed. It performs HTTP join and registered completion,
HTTP replay with the same key and registered result, a fresh no-change positive confirmation, denied join,
later-T close and completion, completed leave replay, empty leave, rejoin, and same-T close/delete. Snapshots
pin count, version, actual open source rows and retained intervals at every boundary. Four actual row changes
advance version four times; no-change, refusal, empty selection and replay leave both count and version alone.
Registered inverse/proof/follow completion remains inside observation, so its work cannot disappear behind a
direct SQL helper. Completion facts do not create an additional contribution.

The three independent pressure axes are 256/1024/4096 unrelated Realms with one member each, unrelated members
in one other fixed Realm, and closed intervals sharing the selected Realm/account prefix. Population is seeded
before observation on the hot route. No axis grows the other pressure population. The selected active
neighbourhood is at most one row, and each cycle retains exactly one additional closed interval, independent
of scale. The operation's finite self-generated history is kept distinct from the seeded history pressure.
There is no page/batch input to this operation; each source command selects one exact reservation.

The shared `checkGrowth` classifier applies the owning rows/statements/blocks bound to the whole native cycle.
Raw occurrence documents then bind every nested count lock/read/delta to the actual source SQL occurrence and
backend. Each changed row requires two control locks and one count update; the fresh positive no-op requires
none. A second shared growth classification checks only those nested control plans, including actual rows,
loops and buffers, in every repetition. Source/control access-path checks retain the shared physical scan rule.
The test prints three-scale native and nested-control measurements only after these assertions are reached.
No allowance, planner setting, shared classifier or existing test is changed.

A separate native publication has a test-local deferred constraint fault at COMMIT. It first verifies that the
native count trigger saw its increment in the same transaction, then rejects that transaction. Acceptance requires
the exact injected error, captured nested count update, registered failure/compensation, and unchanged source
rows and control state. The fault neither produces membership nor supplies authority.

## Producer limits and execution

The supported deletion seam is `membership.ts:writeMembership` → `membership-close.sql`'s `removed` CTE,
reached through the real leave workflow with its clock held at the open T. A historical retained-row eraser is
not exposed by that workflow. Account erasure remains the existing membership consumer's pending/unavailable
seam described by the owner; this slice does not claim to execute that producer. Tombstones, terminal/inverse
facts, Access role loss and pending erasure are not physical source removal. The suite creates no such synthetic
removal outcomes. First installation's indexed open/unkeyed/end probes are permitted by the Cost row; this suite
starts with native Realm controls installed and does not substitute initialization/backfill evidence.

Premises were inspected on clean retained source `c968558f1f20e21ca88ac8e7b26754a3fd642d7a`. Existing
`member-count.test.ts` proves semantic count/version/removal/rollback outcomes, but its manual source writes do
not supply native three-scale nested-trigger observations. Existing membership growth/production Access and
registered transition fixtures supply the reusable boundaries above. Sources read: the linked community owner
and content Done-when/Acceptance sections; existing member-count, membership, membership-history and join growth
coverage; membership open/close/publication and HTTP acceptance code; Accounts workflow registration;
community/work registry; and shared growth capture, cost, occurrence and access-path APIs. No reference source
is named by this contract and none was needed to change product behaviour.

Commands bound to this slice, from the worktree root:

```sh
bun run --cwd services/kernel typecheck
bun run --cwd services/kernel check test/community/growth-realm-member-count-maintenance.test.ts
```

Native/browser/acceptance launch admission belongs to the controller. Authored assertions and source inspection
are not measured passes. Until the focused native command executes on the controller-bound source, there are
no reached native assertions or three-scale observations to report and no promotion claim.

Both commands above were submitted for source `3a4d960e34385f0674a9aec38bb643cc74e1054d`.
Typecheck exited 70 before compilation: `remote-check: infrastructure failure`, reason
`absolute preparation deadline exceeded`, stalled phase `source-artifact-publication`.
The focused run exited 1 in schema preflight: `error: Schema dump differs from db/library/schema.sql.`
Its diagnostic reported `Checked source commit/tree: UNKNOWN (no retained source provenance at this boundary).`
The library schema/migration inputs and check runner are unchanged from the inspected base. The owning repair
seam is the library schema snapshot/migrations and the runner's retained-source provenance, outside this slice.
Neither run reached the authored native assertions; there are no measured three-scale observations or passes.
Controller acceptance remains deferred. No schema check was weakened and no production path was changed.
