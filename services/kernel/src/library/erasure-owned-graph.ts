import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { normalizeCommandKey, noEffect, runCommand, type CommandResult } from '../command/command.ts';
import { partitionOf } from '../route/route.ts';
import { requireRoute, workStepDeadline } from './command-support.ts';
import scope from './erasure-scope.sql';
import { ownedQueries } from './erasure-owned-queries.ts';
import session from './erasure-owned-session.sql';
import collection from './erasure-owned-collection.sql';
import sessionDelete from './erasure-owned-session-delete.sql';
import collectionDelete from './erasure-owned-collection-delete.sql';
import collectionRetain from './erasure-owned-collection-retain.sql';
import units from './erasure-owned-progress-unit.sql';
import changes from './erasure-owned-progress-change.sql';
import members from './erasure-owned-collection-member.sql';
import canonicalFacts from './erasure-owned-canonical-source-fact.sql';
import canonicalState from './erasure-owned-canonical-source-state.sql';
import collectionHistory from './erasure-owned-collection-history.sql';
import { purgeTerminalCollectionPage } from './collection-retention.ts';
import { retireNativeCollectionCapturePage } from './native-source-custody.ts';
import nativeCapture from './erasure-owned-native-source-capture.sql';
import nativeFences from './erasure-owned-native-source-fence.sql';

export const OWNED_PHASES = [
  'published_log',
  'sessions',
  'collections',
  'entry_deleted',
  'label_assignment',
  'personal_label',
  'progress_head',
  'collection_pins',
  'builtin_state_reference_source',
  'builtin_collection_reference',
  'bulk_target',
  'type_preparation_slot',
  'type_preparation_progress',
  'type_preparation_header',
  'shelf_count',
  'shelf_type_reservation',
  'shelf_type_node',
  'shelf_type_root',
  'shelf_type_value',
  'shelf_writer_owner',
  'owner_write_counter',
  'owner_index_label_repair',
  'owner_index_state',
  'owner_member_support',
  'owner_member_index',
  'owner_index_pin',
  'owner_index_control',
  'native_source_capture',
  'fact_source_head',
  // Append phases so existing durable numeric checkpoints keep their meaning.
  'collection_kind_subject',
  'collection_kind_count',
  'collection_kind_observation',
  'collection_kind_retired',
  'collection_kind_consent_consumer',
  'members_preparation_result',
  'members_preparation',
  'members_preparation_owner',
  'bangumi_upload',
  'list_import_mal',
] as const;
const childQueries: {
  units: typeof units;
  changes: typeof changes;
  members: typeof members;
  canonicalFacts: typeof canonicalFacts;
  canonicalState: typeof canonicalState;
  collectionHistory: typeof collectionHistory;
  sessionDelete: typeof sessionDelete;
  collectionDelete: typeof collectionDelete;
  collectionRetain: typeof collectionRetain;
} = {
  units,
  changes,
  members,
  canonicalFacts,
  canonicalState,
  collectionHistory,
  sessionDelete,
  collectionDelete,
  collectionRetain,
};
type Kind =
  | keyof typeof ownedQueries
  | keyof typeof childQueries
  | 'native_source_capture'
  | 'sessions'
  | 'collections'
  | 'collectionLocal'
  | 'bangumi_upload'
  | 'list_import_mal';
export type OwnedGraphInput = {
  accountId: string;
  kind: Kind;
  parent: string | null;
  after: string | null;
  ordinal: number;
  segment: number;
};
export type OwnedGraphPage = {
  kind: string;
  removed: number;
  parent: string | null;
  retain: boolean;
  blocked: boolean;
  collectionDone?: boolean;
  nativeDone?: boolean;
  pendingCollection?: string;
  hasMore?: boolean;
};
type OwnedParent = { id: string; everPublic?: boolean; retain?: boolean };

/** One account-home command, at most 100 raw keys. Receipts checkpoint deletion and
 * small progress together, including a commit followed by a lost DBOS checkpoint.
 * This is local disposition only; shared custody is never inferred from exhaustion.
 */
export async function purgeOwnedGraphPage(pool: Pool, input: OwnedGraphInput): Promise<OwnedGraphPage> {
  const { accountId, kind, parent, after, ordinal, segment } = input;
  const route = requireRoute(accountId);
  if (parent !== null && requireRoute(parent) !== route) throw new TypeError('Foreign graph parent');
  if (
    after !== null &&
    kind !== 'native_source_capture' &&
    kind !== 'collection_kind_consent_consumer' &&
    requireRoute(after) !== route
  )
    throw new TypeError('Foreign graph cursor');
  if (
    kind === 'collection_kind_consent_consumer' &&
    after !== null &&
    (Buffer.byteLength(after, 'utf8') > 255 || !after.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/u.test(after))
  )
    throw new TypeError('Invalid Collection Kind consent cursor');
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || !Number.isSafeInteger(segment) || segment < 0)
    throw new TypeError('Invalid graph checkpoint');
  const digest = createHash('sha256').update(JSON.stringify(input)).digest();
  const result = await runCommand<OwnedGraphPage>(
    pool,
    {
      partition: partitionOf(route),
      deadline: workStepDeadline(),
      receipt: {
        actorAccountId: accountId,
        kind: 'library.account-graph.purge',
        key: normalizeCommandKey({ kind: 'account', id: accountId }, `graph:${segment}:${ordinal}`),
        digest,
      },
      authorization: {
        action: 'library:account-command',
        resource: { route, id: accountId },
        denied: () => new Error('Library graph purge requires the current tombstone'),
        async authorize(tx) {
          if (!(await scope.run(tx, { route, account_id: accountId })))
            throw new Error('Library graph purge requires the current tombstone');
          return 'execute';
        },
      },
    },
    async (tx): Promise<CommandResult<OwnedGraphPage>> => {
      const args = { route, account_id: accountId, after_id: after };
      if (kind === 'bangumi_upload') {
        const rows = await tx.query(
          `WITH keys AS MATERIALIZED (SELECT upload_id,ordinal
          FROM library.bangumi_upload_row WHERE route=$1 AND account_id=$2 ORDER BY upload_id,ordinal LIMIT 100)
          DELETE FROM library.bangumi_upload_row r USING keys k WHERE r.route=$1 AND r.account_id=$2
            AND r.upload_id=k.upload_id AND r.ordinal=k.ordinal`,
          [route, accountId],
        );
        const roots = await tx.query(
          `WITH keys AS MATERIALIZED (SELECT upload_id FROM library.bangumi_upload u
          WHERE route=$1 AND account_id=$2 AND NOT EXISTS (SELECT 1 FROM library.bangumi_upload_row r
          WHERE r.route=u.route AND r.account_id=u.account_id AND r.upload_id=u.upload_id) ORDER BY upload_id LIMIT $3)
          DELETE FROM library.bangumi_upload u USING keys k WHERE u.route=$1 AND u.account_id=$2
          AND u.upload_id=k.upload_id`,
          [route, accountId, 100 - (rows.rowCount ?? 0)],
        );
        const removed = (rows.rowCount ?? 0) + (roots.rowCount ?? 0);
        return {
          value: { kind, removed, parent: null, retain: false, blocked: false },
          events: [
            {
              type: 'com.rezics.library.account-graph.purged.v1',
              subject: accountId,
              data: { accountId, kind, removed },
            },
          ],
        };
      }
      if (kind === 'list_import_mal') {
        const removed = await tx.query(`DELETE FROM library.list_import_mal WHERE route=$1 AND account_id=$2
          AND id IN (SELECT id FROM library.list_import_mal WHERE route=$1 AND account_id=$2 ORDER BY id LIMIT 100)`,
          [route,accountId]);
        return noEffect({ kind, removed: removed.rowCount ?? 0, parent: null, retain: false, blocked: false });
      }
      if (kind === 'native_source_capture') {
        const capture = await nativeCapture.run(tx, { ...args, after_id: after });
        if (!capture)
          return noEffect({ kind, removed: 0, parent: null, retain: false, blocked: false, nativeDone: true });
        const page = await retireNativeCollectionCapturePage(tx, {
          accountId,
          collectionId: capture.collectionId,
          captureId: capture.id,
          episode: { kind: 'terminal' },
        });
        const blocked = page.status === 'blocked' || page.status === 'unavailable';
        const value: OwnedGraphPage = {
          kind,
          removed: 'removed' in page ? page.removed : 0,
          parent: capture.id,
          retain: false,
          blocked,
          nativeDone: page.status !== 'progress',
          ...(blocked ? { pendingCollection: capture.collectionId } : {}),
        };
        if (value.removed === 0) return noEffect(value);
        return {
          value,
          events: [
            {
              type: 'com.rezics.library.account-graph.purged.v1',
              subject: accountId,
              data: { accountId, kind, removed: value.removed },
            },
          ],
        };
      }
      if (kind === 'collectionLocal') {
        if (parent === null) throw new TypeError('Collection cleanup requires an exact parent');
        const page = await purgeTerminalCollectionPage(tx, { accountId, collectionId: parent });
        const value: OwnedGraphPage = {
          kind,
          removed: page.removed,
          parent,
          retain: false,
          blocked: page.status === 'retained',
          collectionDone: page.status === 'purged' || page.status === 'stale',
        };
        if (page.removed === 0) return noEffect(value);
        return {
          value,
          events: [
            {
              type: 'com.rezics.library.account-graph.purged.v1',
              subject: accountId,
              data: { accountId, kind, removed: page.removed },
            },
          ],
        };
      }
      if (kind === 'sessions' || kind === 'collections') {
        const query = { ...args, after_id: after };
        const row: OwnedParent | null =
          kind === 'sessions'
            ? ((await session.run(tx, query)) as OwnedParent | null)
            : ((await collection.run(tx, query)) as OwnedParent | null);
        return noEffect({
          kind,
          removed: 0,
          parent: row?.id ?? null,
          retain: row !== null && 'retain' in row && row.retain === true,
          // The locked local disposer distinguishes real custody from historical visibility.
          blocked: false,
        });
      }
      let removed: number;
      let hasMore = false;
      if (kind in childQueries) {
        if (parent === null) throw new TypeError('Graph child requires an exact parent');
        // Fixed dispatch, never runtime SQL construction or a table-name query API.
        const query = { ...args, parent_id: parent };
        switch (kind) {
          case 'units':
            removed = (await units.run(tx, query)).length;
            break;
          case 'changes':
            removed = (await changes.run(tx, query)).length;
            break;
          case 'members':
            removed = (await members.run(tx, query)).length;
            break;
          case 'canonicalFacts':
            removed = (await canonicalFacts.run(tx, query)).length;
            break;
          case 'canonicalState':
            removed = (await canonicalState.run(tx, query)).length;
            break;
          case 'collectionHistory':
            removed = (await collectionHistory.run(tx, query)).length;
            break;
          case 'sessionDelete':
            removed = (await sessionDelete.run(tx, query)).length;
            break;
          case 'collectionDelete':
            removed = (await collectionDelete.run(tx, query)).length;
            break;
          case 'collectionRetain':
            removed = (await collectionRetain.run(tx, query)).length;
            break;
          default:
            throw new TypeError('Invalid graph child');
        }
      } else {
        if (!(kind in ownedQueries)) throw new TypeError('Invalid graph namespace');
        // All fixed owner statements have exactly the same typed integer/uuid input.
        removed = (await ownedQueries[kind as keyof typeof ownedQueries].run(tx, args)).length;
        if (kind === 'bulk_target' && removed < 100) {
          // Keep the installed Accounts phase and its 100-row budget, disposing empty roots too.
          const roots = await tx.query(
            `WITH keys AS MATERIALIZED (
            SELECT operation_id FROM library.bulk_operation WHERE route=$1 AND account_id=$2
              ORDER BY operation_id LIMIT $3)
            DELETE FROM library.bulk_operation AS operation USING keys WHERE operation.route=$1
              AND operation.account_id=$2 AND operation.operation_id=keys.operation_id
              AND NOT EXISTS (SELECT 1 FROM library.bulk_target WHERE route=$1
                AND operation_id=operation.operation_id ORDER BY ordinal LIMIT 1)`,
            [route, accountId, 100 - removed],
          );
          removed += roots.rowCount ?? 0;
        }
        // The final writer barrier itself advances the native account fence. Dispose controls AFTER it.
        if (kind === 'fact_source_head') {
          const controls = (await nativeFences.run(tx, args)).length;
          removed += controls;
          hasMore = controls >= 98;
        }
      }
      const value = { kind, removed, parent: null, retain: false, blocked: false, ...(hasMore ? { hasMore } : {}) };
      return {
        value,
        events: [
          {
            type: 'com.rezics.library.account-graph.purged.v1',
            subject: accountId,
            data: { accountId, kind, removed },
          },
        ],
      };
    },
  );
  return result.value;
}
