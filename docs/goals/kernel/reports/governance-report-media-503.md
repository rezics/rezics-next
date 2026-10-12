REGRESSION in 29018b744

# Governance report media activation triage

The regression is an added owner-pool precondition that the governance fixture
does not satisfy. It is not evidence of unreachable object storage, a missing
media dependency, or test ordering. Keep the persistence fence; configure the
fixture's Content pool with the existing production connection bounds.

## Reproduction and attribution

- Trust-ops reported QA `20261012t020811-b116b5` at `d63eff19d`, failing
  `tests/qa/integration/governance-report.test.ts:321`. Those artifacts were not
  available; their environment, image identity and internal exception cannot be
  independently checked here.
- The clean worker checkout was `0a821a13575c089aa643a129b70e63051d93fb26`.
  The test, media modules, immutable-object adapter, Access admission and pool
  bounds have no changes between the reported source and this checkout.
- Running `bun scripts/goal/goalctl.ts test tests/qa/integration/governance-report.test.ts`
  once alone produced QA `20261012t022145-d20481`: **4 pass, 1 fail**, reproducing
  the same activation assertion. Its `logs/integration-1.log` records the request
  at lines 317–319 and the response:

  ```json
  {"type":"https://rezics.com/problems/media_unavailable","title":"Media owner is unavailable","status":503,"code":"media_unavailable"}
  ```

The request is authenticated `PUT /v1/media/uploads/<reserved upload UUID>/bytes`
with the generated 32×32 PNG, following a successful `POST /v1/media/uploads`.
The log does not retain the actual upload UUID or internal exception:
`mediaError` deliberately replaces all four classes with this generic problem.
The exact internal throw identified by the execution path is
`MediaUnavailable('media persistence requires a bounded transaction')`, at
`services/main/src/modules/media/store.ts:764`; this is a code-derived diagnosis,
not an exception captured verbatim by QA logging.

The fixture creates a bare `new Pool({ connectionString, max: 4 })` at
`tests/qa/integration/governance-report.test.ts:39`. The generated database URL
has no startup timeout options (`scripts/dev/config.ts:257`), and clone creation
only replaces its pathname (`tests/qa/support/databases.ts:88`). PostgreSQL's
disabled idle-transaction timeout is zero. `settleUpload` reads that setting and
rejects zero **before invoking either object write**.

`git log -S 'bounds.idle_ms <= 0' -- services/main/src/modules/media/store.ts`
identifies `29018b744`. Its diff changes `< 0` to `<= 0` and removes the explicit
zero-timeout support (`bounds.idle_ms || Infinity`) introduced by `21b41a244`.
`25be7149e` introduced fenced persistence but not this requirement.
`6983a26e3` concerns erasure inventory, outside activation; `6275b975f` changes
suppression checks after persistence, beyond the failing guard. Ordinary SQL
errors from missing migrations do not map to these four error classes.

The permitted comparison run used a detached checkout of `29018b744^`,
`2d1b994025ce3b875142129dc5ccb55fdb3d2cf8`, under this worker's `.temp/worktrees/`.
The same command produced QA `20261012t022400-590261`: **5 pass, 0 fail** in
25.7 seconds. Both runs reported stable source. The parent retains the earlier
fenced persistence and object-write cleanup but accepts a disabled PostgreSQL
idle timeout. This comparison and the precise guard diff establish the
regression attribution; the parent predates other intervening changes, so this
is not a one-line experimental patch of current main.

The current checkout contains the generated Fuseki image stamp
`rezics/fuseki:6.2.0-cmd0.5.39-d4f216a2806b` in `infra/dev/compose.yaml`.
Successful graph commands and reservations show that the reproduction stack
was operating. No claim about the original run's image or environment can be
made from its run ID alone. An image change is unnecessary to explain the
reproduced owner-pool rejection.

## Activation error inventory

| Class | Reachable cause on this request |
| --- | --- |
| `AdmissionUnavailable` | `access/admission.ts:933–942`: missing or closed Access recovery fence during principal lookup. Activation repeats lookup after intake. |
| `MediaUnavailable` | `media/store.ts:764`: unbounded pool; `:772`: persistence deadline; `:830`: successful recovery receipt missing its original; `:954–975`: missing or inconsistent Content revision manifest. `media/commands.ts:200,206`: missing tracked-write/deletion adapter or mismatched quarantine bytes. |
| `ObjectUnavailable` | `infrastructure/immutable-objects.ts:460,463`: conditional PUT failure; `:667–669,701`: failed GET or stream read; aborts and unsuccessful read-back can also produce this class. |
| `ObjectIntegrityError` | `immutable-objects.ts:703`: retrieved bytes do not match their digest. Invalid digest at `:269` is not expected for activation's computed SHA-256. |

`routes/media.ts:468–486` dispatches this request and maps errors at `:54–70`.
Delivery handlers do not run. No matcher is configured by this fixture.
The same fixture supplies media dependencies to reservation and activation;
reservation succeeds. Work and Structure creation also use initialized S3
adapters before this request, so their successful creation provides storage
evidence, though it cannot rule out every subsequent transient outage.
The reproduced request reaches the zero-timeout guard before such an outage
could matter. Running the file alone reproduces the failure, excluding dependence
on another test file's fixture state.

## Smallest fix

Use `boundedPool({ connectionString: databases.urls.content, max: 4 })` in the
governance fixture, from `services/main/src/infrastructure/pg-pool.ts`, as the
production Content pool already does (`services/main/src/index.ts:30`). Its
existing `CONNECTION_BOUNDS` supplies a 60-second idle-transaction timeout and
the other owner connection bounds. Do not weaken the persistence guard or add
a parallel timeout policy. The missing precondition is a finite, positive
`idle_in_transaction_session_timeout` on the actual Content connection that
holds the media owner transaction. No owner code was changed during triage.

The manager should apply the fixture fix and rerun this file, then check other
fixtures constructing bare Content pools that exercise media activation.

## Checks and retained evidence

The current-run artifacts remain under `.artifacts/qa/20261012t022145-d20481/`.
The comparison summary, test log and JUnit record were copied under
`.temp/media-activation-triage/20261012t022400-590261/` before removing its
throwaway checkout. These local artifacts are not committed.

`task docs:check` passed its 13 checker tests and failed documentation navigation
only: this new report is not yet reachable from `docs/README.md`. Linking it
requires a manager-owned navigation change outside this read-only triage claim.
