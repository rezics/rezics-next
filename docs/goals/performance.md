# Performance

## Outcome

People and API consumers receive predictable work bounds as catalogue, history and tenant populations grow.
Contributors demonstrate those bounds with shared native evidence, rather than machine speed.

## Done when

- Every owned read, write, authorization, validation, projection and cleanup derivation names its anchors, examined
  work, admitted expansion and complete nested native cost, and links to a native growth check.
- The shared harness measures statements, examined rows, buffers and other relevant engine work at three seeded
  scales. It grows unrelated data and history independently of the selected neighbourhood, including Auth workflow
  and request history at 256, 1,024 and 4,096 records.
- Kernel command execution, keyset reads, receipts, outbox and relays, Access/Auth, semantic/content, search, library,
  commerce, imports, lifecycle jobs including Auth workflow-history retention, and control-plane operations meet
  their stated bounds.
- Large jobs make bounded resumable progress. Denied, empty, deep-page and cleanup paths obey the same principle,
  including Auth zero-eligible and post-drain repeated-empty retention batches.
- Filter, source and order plans have derived budgets in honest work units, including preparation, rereads, discarded
  candidates and native disclosure. A shorter returned page or deduplicated terminal set cannot reprice raw work.
- Every violated derivation or growth assertion is corrected with its owner and verified through native acceptance.
  Load-sensitive classification and background-work attribution preserve visible diagnostic evidence.

## Scope

Includes the shared native growth harness, fixtures, operation derivations, hot-path corrections and cross-owner
receiving across [public scope](../scope.md). Slow engine constants are distinct from work growing with unrelated
data. Wall-clock thresholds alone do not prove asymptotic behavior.

The assigned website work covers signed-in account Settings, notices, preferences, section navigation, safety, and
the assigned Profile/Watches journeys through the existing real typed Web shell. M1 is the signed-in Settings
Profile/Watches path. Product owners retain policy, database schema and SQL semantics, Source contracts and admission
authority. Do not enlarge production exposure or native/browser admission.

## Ownership

Performance owns `services/kernel/test/support/growth*`, growth suites under module test directories, shared bounds
and cross-owner receiving. [Kernel performance](../../services/kernel/performance-contract.md) owns shared harness
and native evidence rules; [Library performance](../../services/kernel/src/library/performance-contract.md) owns
Collection derivations and custody. [Work](../../services/kernel/src/work/README.md#selected-execution-producer)
and [History](../../services/kernel/src/history/README.md#selected-native-executor-binding) own their execution
adapters. [Architecture](../architecture.md#modules-and-boundaries) owns pure-package and adapter direction, and
[verification](../development/verification.md#native-growth-evidence) owns evidence and check placement.

Performance owns the assigned Settings/Profile/Watches interface journeys. [Settings](../../apps/web/src/settings/README.md),
[Inbox](../../apps/web/src/inbox/README.md) and the [profile editor](../../apps/web/src/accounts/profile-editor/README.md)
own their recovery semantics. Web owns the shared shell, patterns and visual acceptance. Accounts, Auth and Content
retain their native backends.

## Dependencies

Native owner operations and realistic fixtures with isolated resources are required. Other Goals own their local
derivations and consume the common harness. Semantic supplies disclosure dependencies; Search and Commerce expose
concrete admitted plans. Performance derives and verifies their budgets without reproducing owner logic in a
benchmark.

Decision: Semantic domain composition is proved by a fake-port application load and one ordinary native identity
epoch through the composed participants. Public ports are Library custody, Search currentness, Rating review,
Content lifecycle including batch cover reads, hashing, routing and the fact store. Inward subject, summaries and
bulk HTTP resolve Content lifecycle through `adapters/ports.ts`; composition binds the native cover adapter even
when identity participants are absent. Rating-review keys 2 / locators 2
/ operand 16,384 bytes live in identity-core `rating-review-bounds.ts`. Observed counters remain item facts 512, those
rating-review limits, identity page 100 originals, epoch segment 100 pages and frontier 8 keys / 2,048 bytes / 100
step rows. Cost derivations stay on the existing identity-epoch and item growth contracts. Compact tests pin the
fake-port domain and ordinary native composition; kernel-semantic baseline rule 2/3 is 361/383 (from 521/384).
Composed native identity owns the worker pool and max-one relay sharing that yields a held command lease;
terminal-closure growth binds a non-owner home role with leakproof indexable RLS after BEGIN. Preparing jobs own the
prepare reservation.

## Acceptance

The [capability acceptance](performance.capabilities.md) owns user cases and frozen scenarios. Use the
[shared growth harness](../../services/kernel/performance-contract.md) and module suites through their owning check
runners. Measure at three scales, such as 1×, 8× and 64×, against constant, logarithmic or change-proportional bounds
derived before implementation; use the prescribed Auth scales above where applicable. Count native examined work,
not only calls, and observe projection or worker work within its operation context. Report independently owned
background work separately.

Root, module and native evidence retain separate meaning. Root SQL acceptance uses the supported Reylo types through
the affected Web/root checks; fast copy-on-write preparation does not establish SQL closure. Infrastructure failure
or unavailable evidence is neither denial nor a product pass. Use [verification](../development/verification.md)
for evidence and check-host placement.

## Kernel Work domain inversion

Decision: Compact `domain-composition` tests are the fewest pins for Work enqueue, registration, selected admission
and retirement against fake ports; worker and kernel landing tests carry `KERNEL_RECEIPT_KEYS` through
`workerTestEnv`. The existing growth-work-client, selected-runtime-native, sdk-transaction-fence,
sdk-retirement-fence and growth-retention fixtures remain the bounded-work proof. Search tombstone registration
includes both `search_account_erasure` and `search_erasure`. Contract/core/application load no downstream
implementations. Native adapters are bound by ordinary `createKernel`/`server`/`worker` composition, with product
assembly in `composition/work-modules.ts` using `ratingNativeWorkModule`. The split adds no query or extra
statement; observed cost stays the existing admitted-path declarations.

## Kernel History domain inversion

Decision: `history-complete-current-architecture-receiving` keeps History contract/core/application implementation-free
and binds its typed native capability in `composition/history.ts`. Server and worker install it during startup;
`composition/preload.ts` exposes that binding for test and command preloads. Compatibility callers use the declared
History application and contract entries, including Work registry, selected-runtime, receiving and durable-locator
paths. Test choice: use the focused causal History regressions for application/native composition, prepaid identity,
identity-history recording, Zone receiving, record purge, agent verification reversal and receipt-key cutover, plus
the architecture test; do not add a duplicate synthetic suite. Original native acceptance remains open after
land-first verification.

## Kernel Access domain inversion

Decision: Compact causal tests pin Access allow/deny, identity recovery with the original actor/request/deadline, and
original-work admission against fake ports; the existing native membership growth check remains the bounded-work
proof. Contract/core/application load no downstream implementations. Native adapters are bound by ordinary
`createKernel`/`server`/`worker` composition. The split adds no query or extra statement; cost stays the existing
producer declarations composed through `admitOriginalWork` and Kind-audience work vectors.
Decision: pin this increment's user-visible check-infrastructure behaviour with the existing remote-check, check-ssh,
compiler-database, Kernel script and page-data unit files rather than a second suite, including the 120s host-lifetime
`docker rm` and detached SIGTERM cleanup. Observed bounds: one OpenSSH
ControlMaster per configured host under a short owned `$XDG_RUNTIME_DIR/rezics-ssh` (relocated under `/tmp` when
unix_listener would overflow); throwaway PostgreSQL `--rm` plus owner-pid cleanup; `docker run`/`rm -f` spawn 120s (Auth
`DEFAULT_RUN_TIMEOUT`) and exec/ps/port probes 5s, because a 10s cap timed out a live host-b `database-image` at 10.012s
and a 3s host-lifetime `docker rm -f` timed out on SIGTERM cleanup; signal-path removal is detached so the 200ms
supervisor SIGKILL cannot abort it;
labelled volume not 1 GiB tmpfs; a failed create reaps its nonce; `container:<id>` isolated-stack
attachment with an independent TCP-to-Unix forwarder; migrations wait for in-container `pg_isready` and a protocol
reply, not a TCP accept that EOFs; empty-directory manifests hash `directory\0`; page-data boot keeps the first
substantive error after Task `$ ` echoes. After output-tree restore, candidate fingerprints ignore the published
kernel-client root. Inherited Library `@rezics/bounds` imports and the two ClassDeclaration `extends` reads stay with
kernel-library and kernel zones.
Decision: Management walk setup idle-in-transaction and Access-deadline termination is received through that same
throwaway/isolated-stack database lifetime. Content keeps the launcher, stack and cleanup. Original walks remain
open. Driver main versus canonical publication is a control-plane owner item.
