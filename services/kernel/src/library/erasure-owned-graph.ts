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
  'owner_write_counter',
  'owner_index_label_repair',
  'owner_index_state',
  'owner_member_support',
  'owner_member_index',
  'owner_index_pin',
  'owner_index_control',
  'fact_source_head',
] as const;
const childQueries = {
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
type Kind = keyof typeof ownedQueries | keyof typeof childQueries | 'sessions' | 'collections' | 'collectionLocal';
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
  if (after !== null && requireRoute(after) !== route) throw new TypeError('Foreign graph cursor');
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
      const args = { route, account_id: accountId };
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
          blocked: row !== null && 'everPublic' in row && row.everPublic === true && row.retain !== true,
        });
      }
      let removed: number;
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
      }
      const value = { kind, removed, parent: null, retain: false, blocked: false };
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
