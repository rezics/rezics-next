import { fenceShelfTechnicalWrite } from './shelf-maintenance-runtime.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import type { KernelClock } from '../clock.ts';
import { enqueueIntent, runOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readRelease } from '../semantic/definitions.ts';
import type { WorkClient } from '../work/client.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { workStepDeadline } from './command-support.ts';
import { pinLegacyFactsPage, type LibraryProfileMigrationSource } from './profile-migration-page.ts';
import ensureHead from './profile-migration-lock.sql';
import lockCheckpoint from './profile-migration-checkpoint.sql';
import readCheckpoint from './profile-migration-progress.sql';
import advanceCheckpoint from './profile-migration-advance.sql';

export const LIBRARY_PROFILE_MIGRATION_WORKFLOW = 'library.profileMigration';
export type LibraryProfileMigrationPhase = 'entry' | 'session' | 'copy';
export type LibraryProfileMigrationProgress = {
  accountId: string;
  phase: 'legacy' | LibraryProfileMigrationPhase | 'ready';
  releaseDigest: string | null;
  after: string | null;
};
export type LibraryProfileMigrationRuntime = Readonly<{
  start(input: { accountId: string; releaseDigest: string }): Promise<LibraryProfileMigrationProgress>;
  resume(input: { accountId: string }): Promise<LibraryProfileMigrationProgress>;
  readProgress(input: { accountId: string }): Promise<LibraryProfileMigrationProgress>;
}>;
export type LibraryProfileMigrationBoundary =
  | 'after-page-read-before-cas'
  | 'before-page-commit'
  | 'after-page-commit-before-ack'
  | 'before-owner-ready';
export type LibraryProfileMigrationPageObservation = {
  transactionId: string;
  backendId: number;
  checkpointBefore: LibraryProfileMigrationProgress;
  checkpointAfter: LibraryProfileMigrationProgress;
  sources: {
    phase: LibraryProfileMigrationPhase;
    rows: readonly LibraryProfileMigrationSource[];
    changedIds: readonly string[];
  }[];
  ownerFenceChecked: boolean;
  committed: boolean;
};
export type LibraryProfileMigrationObservation =
  | { kind: 'boundary'; boundary: LibraryProfileMigrationBoundary; page: LibraryProfileMigrationPageObservation }
  | { kind: 'settled'; page: LibraryProfileMigrationPageObservation };
type Dependencies = {
  pool: Pool;
  client: WorkClient;
  clock?: KernelClock;
  /** Trusted host observation only; never accepted in migration input. */
  observe?: (event: LibraryProfileMigrationObservation) => void | Promise<void>;
};
type Checkpoint = NonNullable<Awaited<ReturnType<typeof readCheckpoint.run>>>;
type Locator = {
  accounts: [string];
  releaseDigest: string;
  phase: LibraryProfileMigrationPhase;
  after: string | null;
};
const phases = ['entry', 'session', 'copy'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^sha256:[0-9a-f]{64}$/;

function ownerKey(accountId: string) {
  if (typeof accountId !== 'string' || !uuid.test(accountId) || routeOf(accountId) === null)
    throw new TypeError('Invalid Library profile migration owner');
  return { route: routeOf(accountId)!, account_id: accountId };
}
function closed(input: object, keys: string[]) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(input, key))
  )
    throw new TypeError('Invalid Library profile migration control');
  if (Buffer.byteLength(JSON.stringify(input)) > 4096)
    throw new RangeError('Library profile migration control exceeds 4096 bytes');
}
function progress(accountId: string, row: Checkpoint | null): LibraryProfileMigrationProgress {
  const phase = row?.phase ?? 'legacy';
  if (phase !== 'legacy' && phase !== 'ready' && !phases.includes(phase as LibraryProfileMigrationPhase))
    throw new Error('Invalid stored Library profile migration phase');
  return {
    accountId,
    phase: phase as LibraryProfileMigrationProgress['phase'],
    releaseDigest: row?.digest ?? null,
    after: row?.after ?? null,
  };
}
function locator(state: LibraryProfileMigrationProgress): Locator {
  if (!state.releaseDigest || state.phase === 'legacy' || state.phase === 'ready')
    throw new Error('Library profile migration has no runnable checkpoint');
  return { accounts: [state.accountId], releaseDigest: state.releaseDigest, phase: state.phase, after: state.after };
}
function parseLocator(input: Locator): Locator {
  closed(input, ['accounts', 'releaseDigest', 'phase', 'after']);
  if (!Array.isArray(input.accounts) || input.accounts.length !== 1)
    throw new TypeError('Library profile migration requires one owner');
  ownerKey(input.accounts[0]);
  if (
    !digest.test(input.releaseDigest) ||
    !phases.includes(input.phase) ||
    (input.after !== null &&
      (typeof input.after !== 'string' || !uuid.test(input.after) || routeOf(input.after) === null))
  )
    throw new TypeError('Invalid Library profile migration checkpoint');
  return input;
}
async function enqueue(tx: OperationalTransaction, state: LibraryProfileMigrationProgress) {
  if (state.phase === 'ready') return;
  const input = locator(state);
  parseLocator(input);
  await enqueueIntent(tx, {
    queue: 'maintenance',
    workflowName: LIBRARY_PROFILE_MIGRATION_WORKFLOW,
    workflowId: `${LIBRARY_PROFILE_MIGRATION_WORKFLOW}:${state.accountId}:${state.releaseDigest}:${state.phase}:${state.after ?? 'start'}`,
    input,
  });
}
function transaction<T>(
  deps: Dependencies,
  accountId: string,
  body: (tx: OperationalTransaction) => Promise<T>,
  transactionObservation?: {
    beforeCommit(): void | Promise<void>;
    afterRollback(): void | Promise<void>;
  },
) {
  const key = ownerKey(accountId);
  return runOperationalTransaction(
    deps.pool,
    {
      mode: 'work-step',
      partition: partitionOf(key.route),
      kind: LIBRARY_PROFILE_MIGRATION_WORKFLOW,
      accounts: [accountId],
      workClient: deps.client,
      deadline: workStepDeadline(),
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      ...(transactionObservation ? { transactionObservation } : {}),
    },
    async (tx) => {
      await fenceShelfTechnicalWrite(tx, { route: key.route, accountId });
      return body(tx);
    },
  );
}

/** One owner-home transaction: raw source allowance is shared across every phase.
 * The source-head checkpoint is also the native completion receipt. Repeating an
 * old locator does no work; the next durable intent committed with the new pins.
 */
async function step(deps: Dependencies, input: Locator): Promise<LibraryProfileMigrationProgress> {
  parseLocator(input);
  const accountId = input.accounts[0];
  const key = ownerKey(accountId);
  let observed: LibraryProfileMigrationPageObservation | undefined;
  const boundary = async (boundary: LibraryProfileMigrationBoundary) => {
    if (observed) await deps.observe?.({ kind: 'boundary', boundary, page: structuredClone(observed) });
  };
  const result = await transaction(
    deps,
    accountId,
    async (tx) => {
      observed = undefined;
      const row = await readCheckpoint.run(tx, key);
      const state = progress(accountId, row);
      if (!row || state.releaseDigest !== input.releaseDigest) throw new Error('Unknown Library profile migration');
      if (state.phase !== input.phase || state.after !== input.after) return state;
      if (deps.observe) {
        const identity = (
          await tx.query<{ transactionId: string; backendId: number }>(
            'SELECT pg_current_xact_id()::text AS "transactionId", pg_backend_pid() AS "backendId"',
          )
        ).rows[0]!;
        observed = {
          ...identity,
          checkpointBefore: { ...state },
          checkpointAfter: { ...state },
          sources: [],
          committed: false,
          ownerFenceChecked: true,
        };
      }
      let remaining = 100;
      while (state.phase !== 'ready' && remaining > 0) {
        const page = await pinLegacyFactsPage(tx, {
          accountId,
          kind: state.phase,
          releaseDigest: input.releaseDigest,
          after: state.after,
          limit: remaining,
          ...(observed
            ? {
                observeRead: async (rows: readonly LibraryProfileMigrationSource[]) => {
                  observed!.sources.push({
                    phase: state.phase as LibraryProfileMigrationPhase,
                    rows: structuredClone(rows),
                    changedIds: [],
                  });
                  await boundary('after-page-read-before-cas');
                },
                observeChanged: (ids: readonly string[]) => {
                  observed!.sources.at(-1)!.changedIds = [...ids];
                },
              }
            : {}),
        });
        remaining -= page.examined;
        state.after = page.after;
        if (!page.exhausted) break;
        state.phase = phases[phases.indexOf(state.phase) + 1] ?? 'ready';
        state.after = null;
      }
      if (observed) observed.checkpointAfter = { ...state };
      if (state.phase === 'ready') await boundary('before-owner-ready');
      // Do not hold the source-head row while a source read is paused. Ordinary
      // writers also advance this head. The exact old locator is the checkpoint
      // CAS; a lost CAS rolls back every pin in this serializable attempt.
      const advanced = await tx.query(
        `UPDATE library.fact_source_head
       SET profile_migration_phase=$3, profile_migration_digest=$4, profile_migration_after=$5::uuid
       WHERE route=$1 AND account_id=$2 AND profile_migration_phase=$6
         AND profile_migration_digest=$4 AND profile_migration_after IS NOT DISTINCT FROM $7::uuid
       RETURNING account_id`,
        [key.route, accountId, state.phase, input.releaseDigest, state.after, input.phase, input.after],
      );
      if (advanced.rowCount !== 1)
        throw Object.assign(new Error('Library profile migration checkpoint CAS lost'), { code: '40001' });
      await enqueue(tx, state);
      return state;
    },
    deps.observe
      ? {
          beforeCommit: () => boundary('before-page-commit'),
          afterRollback: async () => {
            if (observed) await deps.observe!({ kind: 'settled', page: structuredClone(observed) });
            observed = undefined;
          },
        }
      : undefined,
  );
  if (observed) {
    observed.committed = true;
    try {
      await boundary('after-page-commit-before-ack');
    } finally {
      await deps.observe!({ kind: 'settled', page: structuredClone(observed) });
    }
  }
  return result;
}

/** Trusted host/operator API only. No caller-supplied verifier, profile body or pin.
 * Definitions are observed before checking out the owning transaction. The published
 * digest is captured once; resume and all workers use only that native checkpoint.
 */
export function createLibraryProfileMigrationRuntime(deps: Dependencies): LibraryProfileMigrationRuntime {
  async function readProgress(input: { accountId: string }) {
    closed(input, ['accountId']);
    const key = ownerKey(input.accountId);
    return withConnection(deps.pool, async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const account = await readAccount(client, key.route, input.accountId);
        if (!account || account.state !== 'active' || account.fenced) throw new LifecycleDeniedError();
        const state = progress(input.accountId, await readCheckpoint.run(client, key));
        await client.query('COMMIT');
        return state;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
  return Object.freeze({
    async start(input: { accountId: string; releaseDigest: string }) {
      closed(input, ['accountId', 'releaseDigest']);
      const key = ownerKey(input.accountId);
      if (typeof input.releaseDigest !== 'string' || !digest.test(input.releaseDigest))
        throw new TypeError('Invalid Library profile migration destination digest');
      // composed:false is essential: only an actually published immutable release
      // can authorize this operation, never an unpersisted composition or Global head.
      const release = await readRelease(deps.pool, input.releaseDigest, { composed: false });
      if (
        !release?.libraryProfiles?.['legacy-fixed-v1'] ||
        Object.values(release.types).some((type) => type.library?.profileId === 'legacy-fixed-v1')
      )
        throw new TypeError('Destination must publish unattached legacy-fixed-v1');
      return transaction(deps, input.accountId, async (tx) => {
        await ensureHead.run(tx, key);
        const row = await lockCheckpoint.run(tx, key);
        const state = progress(input.accountId, row);
        if (state.releaseDigest !== null && state.releaseDigest !== input.releaseDigest)
          throw new TypeError('Library profile migration destination is already captured');
        if (state.phase === 'legacy') state.phase = 'entry';
        state.releaseDigest = input.releaseDigest;
        await advanceCheckpoint.run(tx, {
          ...key,
          phase: state.phase,
          digest: input.releaseDigest,
          after: state.after,
        });
        await enqueue(tx, state);
        return state;
      });
    },
    async resume(input: { accountId: string }) {
      const state = await readProgress(input);
      if (state.phase === 'ready') return state;
      // An operator can advance a failed/cancelled workflow's exact native frontier.
      // It never revives an old DBOS execution or trusts a checkpoint from its caller.
      return step(deps, locator(state));
    },
    readProgress,
  });
}

/** Installed by the one Library WorkModule; deliberately no schedule/activation hook. */
export function registerLibraryProfileMigrationWork(context: WorkContext): void {
  const page = DBOS.registerStep(
    async (input: Locator) => {
      await step(context, input);
    },
    { name: 'library.profileMigrationPage', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(
    async (input: Locator) => {
      await page(input);
    },
    { name: LIBRARY_PROFILE_MIGRATION_WORKFLOW },
  );
}
