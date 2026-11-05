import { purgeSavedCollectionPage } from './saved-collection-retention.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool, PoolClient } from 'pg';
import { shareAccount } from '../access/account-share.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  noEffect,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { PARTITIONS, partitionOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { requireRoute, workStepDeadline } from './command-support.ts';
import due from './collection-retention-due.sql';
import lock from './collection-retention-lock.sql';
import members from './collection-retention-members.sql';
import facts from './collection-retention-facts.sql';
import state from './collection-retention-state.sql';
import references from './collection-retention-references.sql';
import metadata from './collection-retention-metadata.sql';
import metadataHistory from './collection-metadata-history-cleanup.sql';
import head from './collection-retention-head.sql';
import retireFence from './native-source-custody-retire-fence.sql';
import terminalScope from './erasure-scope.sql';
import retentionPartition from './collection-retention-partition.sql';
import { retireNativeCollectionCapturePage, type NativeSourceRetirement } from './native-source-custody.ts';
import {
  executeCollectionRetentionControl,
  executeCollectionRetentionQuery,
  withCollectionRetentionDeclaration,
  withCollectionRetentionEngineRequest,
} from './collection-retention-bounds.ts';

export const COLLECTION_RETENTION_WORKFLOW = 'library.collectionRetention';
export const COLLECTION_RETENTION_SCHEDULE = 'library.collectionRetention.every-10-minutes';
const SEGMENT_WORKFLOW = 'library.collectionRetention.segment';
export type CollectionDeletionKey = Readonly<{
  route: number;
  collectionId: string;
  accountId: string;
  deletionId: string;
  revision: number;
  purgeAfter: string;
}>;
type Cursor = { partition: number; after: { purgeAfter: string; route: number; collectionId: string } | null };
type Segment = {
  root: string;
  sequence: number;
  cutoff: string;
  cursor: Cursor;
  current: CollectionDeletionKey | null;
};
export type CollectionCleanupPage = Readonly<{
  status: 'progress' | 'purged' | 'stale' | 'not_due' | 'retained';
  removed: number;
  custody?: 'collection_source_and_destination_disposition' | 'native_source_capture' | 'account_fence';
}>;
type LockedCollection = NonNullable<Awaited<ReturnType<typeof lock.run>>>;

function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > 4096) throw new RangeError('Collection retention exceeds 4096 bytes');
  return value;
}

function validateKey(key: CollectionDeletionKey): void {
  if (
    requireRoute(key.collectionId) !== key.route ||
    requireRoute(key.accountId) !== key.route ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key.deletionId) ||
    !Number.isSafeInteger(key.revision) ||
    key.revision < 2 ||
    !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/.test(key.purgeAfter) ||
    !Number.isFinite(Date.parse(key.purgeAfter))
  )
    throw new TypeError('Invalid exact Collection deletion key');
  bounded(key);
}

export async function pageDueCollectionDeletions(
  connection: Pick<PoolClient, 'query'>,
  input: { partition: number; cutoff: string; after: Cursor['after'] },
): Promise<CollectionDeletionKey[]> {
  if (!Number.isInteger(input.partition) || input.partition < 0 || input.partition >= PARTITIONS)
    throw new RangeError('Invalid Collection retention partition');
  if (input.after && partitionOf(input.after.route) !== input.partition)
    throw new RangeError('Foreign Collection retention cursor');
  const rows = await withCollectionRetentionDeclaration('duePage', () =>
    executeCollectionRetentionQuery('due', due, connection, {
      partition_no: input.partition,
      cutoff: input.cutoff,
      after_time: input.after?.purgeAfter ?? null,
      after_route: input.after?.route ?? null,
      after_id: input.after?.collectionId ?? null,
    }),
  );
  const keys = rows.map((row) => {
    if (row.accountId === null || row.deletionId === null || row.purgeAfter === null)
      throw new Error('Due Collection lacks its exact owner/deletion episode');
    const key = { ...row, accountId: row.accountId, deletionId: row.deletionId, purgeAfter: row.purgeAfter };
    validateKey(key);
    return key;
  });
  return bounded(keys);
}

/** Caller holds the current owning head and native account fence through commit.
 * Repeated first-remaining indexed pages are their own crash-safe physical frontier.
 * Public source evidence stays intact until the real Source/disposition producer is installed.
 */
async function removeLocalPage(
  tx: CommandTransaction,
  route: number,
  collectionId: string,
  accountId: string,
  parent: LockedCollection,
  episode: NativeSourceRetirement['episode'],
): Promise<CollectionCleanupPage> {
  if (parent.publicCustody)
    return { status: 'retained', removed: 0, custody: 'collection_source_and_destination_disposition' };
  if (parent.sourceCustody) {
    const retirement = await retireNativeCollectionCapturePage(tx, { accountId, collectionId, episode });
    if (retirement.status === 'progress' || retirement.status === 'retired') {
      if (retirement.removed > 0) return { status: 'progress', removed: retirement.removed };
    } else return { status: 'retained', removed: 0, custody: 'native_source_capture' };
  }
  const args = { route, collection_id: collectionId };
  // At most one nonempty child page per transaction; empty seeks are a fixed bound.
  for (const query of [members, facts]) {
    const id = query === members ? 'members' : 'facts';
    const removed = (await executeCollectionRetentionQuery(id, query, tx, args)).length;
    if (removed > 0) return { status: 'progress', removed };
  }
  if (await executeCollectionRetentionQuery('state', state, tx, args)) return { status: 'progress', removed: 1 };
  const referenceCount = (await executeCollectionRetentionQuery('references', references, tx, args)).length;
  if (referenceCount > 0) return { status: 'progress', removed: referenceCount };
  const removed = (await executeCollectionRetentionQuery('metadata', metadata, tx, { ...args, account_id: accountId }))
    .length;
  if (removed > 0) return { status: 'progress', removed };
  const historyRemoved = (await executeCollectionRetentionQuery('metadataHistory', metadataHistory, tx, args)).length;
  if (historyRemoved > 0) return { status: 'progress', removed: historyRemoved };
  const [result] = await executeCollectionRetentionQuery('head', head, tx, {
    ...args,
    account_id: accountId,
    revision: parent.revision,
    source_generation: parent.sourceGeneration,
  });
  if (!result) throw new Error('Locked Collection head still has undisposed local children');
  // The actual locked head above established private disposition. Its final writer hook ran first.
  // A fixed control point plus two empty-prefix probes; removed counts business graph rows, not writer controls.
  await executeCollectionRetentionQuery('retireFence', retireFence, tx, { ...args, account_id: accountId });
  return { status: 'purged', removed: 1 };
}

/** One ordinary physical transaction. No user Actor, grant or receipt authority is fabricated.
 * An interrupted step repeats the remaining keys; restore/redelete is checked before every page.
 */
export async function purgeExpiredCollectionPage(
  { pool, clock, deadline = workStepDeadline() }: { pool: Pool; clock?: KernelClock; deadline?: number },
  key: CollectionDeletionKey,
): Promise<CollectionCleanupPage> {
  validateKey(key);
  let parent: LockedCollection | null = null;
  let accountLive = false;
  const outcome = await withCollectionRetentionDeclaration('removeCommand', () =>
    runCommand<CollectionCleanupPage>(
      pool,
      {
        partition: partitionOf(key.route),
        deadline,
        clock,
        authorization: {
          action: 'library:collection-retention-maintenance',
          resource: { route: key.route, id: key.collectionId },
          denied: () => new Error('Collection retention account fence unavailable'),
          async authorize(tx, attempt) {
            accountLive = false;
            parent = null;
            // Native account anchor first; a terminal account belongs to the single terminal participant.
            try {
              await shareAccount(tx, key.accountId);
              accountLive = true;
            } catch (error) {
              if (!(error instanceof LifecycleDeniedError)) throw error;
            }
            if (accountLive) {
              parent = await executeCollectionRetentionQuery('lock', lock, tx, {
                route: key.route,
                collection_id: key.collectionId,
                purge_after: key.purgeAfter,
                time: authoritativeTimeValue(attempt.time),
              });
            }
            return 'execute';
          },
        },
      },
      async (tx) => {
        if (!accountLive) return noEffect({ status: 'retained', removed: 0, custody: 'account_fence' });
        if (
          !parent ||
          parent.accountId !== key.accountId ||
          parent.state !== 'deleted' ||
          parent.deletionId !== key.deletionId ||
          parent.revision !== key.revision ||
          !parent.deadlineMatches
        )
          return noEffect({ status: 'stale', removed: 0 });
        if (!parent.due) return noEffect({ status: 'not_due', removed: 0 });
        const value = await removeLocalPage(tx, key.route, key.collectionId, key.accountId, parent, {
          kind: 'deleted',
          deletionId: key.deletionId,
          revision: key.revision,
          purgeAfter: key.purgeAfter,
        });
        if (value.removed === 0) return noEffect(value);
        return {
          value,
          events: [
            {
              type: 'com.rezics.library.collection.retention-purged.v1',
              subject: key.collectionId,
              data: { collectionId: key.collectionId, deletionId: key.deletionId, removed: value.removed },
            },
          ],
        };
      },
    ),
  );
  return bounded(outcome.value);
}

/** Exact local seam for the existing terminal participant, inside its receipted command.
 * This never returns an Access ACK, source disposition, or global erasure certificate.
 */
export async function purgeTerminalCollectionPage(
  tx: CommandTransaction,
  input: { accountId: string; collectionId: string },
): Promise<CollectionCleanupPage> {
  const time = authoritativeTimeValue(currentCommand(tx).time);
  const route = requireRoute(input.accountId);
  if (requireRoute(input.collectionId) !== route) throw new TypeError('Foreign terminal Collection');
  if (
    !(await executeCollectionRetentionQuery('terminalScope', terminalScope, tx, { route, account_id: input.accountId }))
  )
    throw new Error('Collection cleanup requires the current native terminal obligation');
  let parent = await executeCollectionRetentionQuery('lock', lock, tx, {
    route,
    collection_id: input.collectionId,
    purge_after: null,
    time,
  });
  if (!parent) return { status: 'stale', removed: 0 };
  if (parent.accountId !== input.accountId) throw new Error('Foreign terminal Collection owner');
  const saved = await purgeSavedCollectionPage(tx, input);
  if (saved) return saved;
  parent = await executeCollectionRetentionQuery('lock', lock, tx, {
    route,
    collection_id: input.collectionId,
    purge_after: null,
    time,
  });
  if (!parent) return { status: 'stale', removed: 0 };
  return withCollectionRetentionDeclaration('terminalSharedCleanup', () =>
    removeLocalPage(tx, route, input.collectionId, input.accountId, parent, { kind: 'terminal' }),
  );
}

/** Installs on the one default Library runtime and existing bounded maintenance queue. */
export async function registerCollectionRetention({ pool, client, clock }: WorkContext): Promise<void> {
  const cutoff = DBOS.registerStep(
    async () => withCollectionRetentionDeclaration('cutoffStep', () => clock().toISOString()),
    { name: 'library.collectionRetention.cutoff' },
  );
  const discover = DBOS.registerStep(
    async (until: string, cursor: Cursor) => {
      bounded(cursor);
      return withCollectionRetentionDeclaration('discoveryStep', () =>
        withConnection(pool, async (connection) => {
          await executeCollectionRetentionControl('discover.begin', (sql) => connection.query(sql));
          try {
            await executeCollectionRetentionControl('discover.timeout', (sql) => connection.query(sql));
            const partition = await executeCollectionRetentionQuery('partition', retentionPartition, connection, {
              partition_no: cursor.partition,
            });
            const page =
              partition?.writeState === 'active'
                ? {
                    kind: 'available' as const,
                    keys: await pageDueCollectionDeletions(connection, { ...cursor, cutoff: until }),
                  }
                : { kind: 'pending' as const };
            await executeCollectionRetentionControl('discover.commit', (sql) => connection.query(sql));
            return page;
          } catch (error) {
            await executeCollectionRetentionControl('discover.rollback', (sql) => connection.query(sql));
            throw error;
          }
        }),
      );
    },
    { name: 'library.collectionRetention.discover', ...COMMAND_STEP_RETRIES },
  );
  const remove = DBOS.registerStep(
    async (key: CollectionDeletionKey) => purgeExpiredCollectionPage({ pool, clock }, key),
    { name: 'library.collectionRetention.remove', ...COMMAND_STEP_RETRIES },
  );
  const continueSweep = DBOS.registerStep(
    async (next: Segment) => {
      bounded(next);
      await withCollectionRetentionDeclaration('continuationEnqueue', () =>
        withCollectionRetentionEngineRequest('continuationEnqueue', () =>
          client.enqueue(
            {
              workflowName: SEGMENT_WORKFLOW,
              queueName: 'maintenance',
              workflowID: `library.collectionRetention:${next.root}:${next.sequence}`,
              workflowIDReusePolicy: 'return-existing',
            },
            next,
          ),
        ),
      );
    },
    { name: 'library.collectionRetention.continue', ...COMMAND_STEP_RETRIES },
  );
  const segment = async (input: Segment) =>
    withCollectionRetentionDeclaration('segment', async () => {
      bounded(input);
      let { cursor, current } = input;
      // A segment has a fixed history bound, even for a very large retained graph.
      for (let n = 0; n < 32 && cursor.partition < PARTITIONS; n++) {
        if (current) {
          const pending = current;
          const result = await withCollectionRetentionEngineRequest('removeStep', () => remove(pending));
          if (result.status === 'progress') continue;
          if (result.status === 'retained') break;
          cursor = {
            partition: cursor.partition,
            after: {
              purgeAfter: pending.purgeAfter,
              route: pending.route,
              collectionId: pending.collectionId,
            },
          };
          current = null;
        } else {
          const page = await withCollectionRetentionEngineRequest('discoveryStep', () =>
            discover(input.cutoff, cursor),
          );
          if (page.kind === 'pending') {
            // The next scheduled sweep retries this home; unavailable is never an empty source proof.
            cursor = { partition: cursor.partition + 1, after: null };
            continue;
          }
          // One key is carried durably; the remaining <=7 keys are revisited by the next indexed seek.
          current = page.keys[0] ?? null;
          if (!current) cursor = { partition: cursor.partition + 1, after: null };
        }
      }
      if (cursor.partition < PARTITIONS)
        await withCollectionRetentionEngineRequest('continuationStep', () =>
          continueSweep({ ...input, sequence: input.sequence + 1, cursor, current }),
        );
    });
  DBOS.registerWorkflow(segment, { name: SEGMENT_WORKFLOW });
  DBOS.registerWorkflow(
    async () =>
      segment({
        root: DBOS.workflowID!,
        sequence: 0,
        cutoff: await withCollectionRetentionEngineRequest('cutoffStep', () => cutoff()),
        cursor: { partition: 0, after: null },
        current: null,
      }),
    { name: COLLECTION_RETENTION_WORKFLOW },
  );
  await client.applySchedules([
    {
      scheduleName: COLLECTION_RETENTION_SCHEDULE,
      workflowName: COLLECTION_RETENTION_WORKFLOW,
      schedule: '*/10 * * * *',
      queueName: 'maintenance',
      cronTimezone: 'UTC',
      automaticBackfill: false,
    },
  ]);
}
