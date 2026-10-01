import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { controlTransaction } from '../access/topology-control.ts';
import { checkMergeAuthority } from '../identity-merge/authority.ts';
import { canonicalCandidate } from '../editorial-review/contract.ts';
import { checkedItem, checkedOutcome, InvalidMerge, itemCommandKey, MERGE_COST,
  mergeDigest, MergeConflict, MergeUnavailable, type IdentityPlan, type ItemOutcome,
  type MergeHandler, type MergeItem } from '../identity-merge/contract.ts';
import { checkedTask } from '../identity-merge/journal.ts';
import { sessionState, type SessionState } from './contract.ts';

export interface SessionMergeDependencies { contentPool: Pool; accessPool: Pool;
  graph: Pick<FusekiClient, 'query'> }
interface Row { id: string; work: string; version: string; state: SessionState }
const columns = 'id,work,version::text,state';
const owner = 'session';
const belongs = (state: SessionState, source: string) => state.target.work === source
  || state.target.resource === source || state.selections.some(selection => selection.target.resource === source);

function snapshot(row: Row): MergeItem {
  if (!Value.Check(sessionState, row.state) || row.state.id !== row.id
    || row.state.target.work !== row.work || String(row.state.version) !== row.version) {
    throw new MergeUnavailable('Consumption attempt state is incomplete');
  }
  return checkedItem({ key: row.id, expectedHead: row.version, before: canonicalCandidate(row.state).candidate });
}

/** An attempt is an independently owned historical use of exact selections.
 * Merging a catalogue identity never changes its target, version, locator or
 * completion. Its native receipt records that deliberate retained outcome. */
export function sessionMergeHandler(dependencies: SessionMergeDependencies): MergeHandler<SessionMergeDependencies> {
  const { contentPool, accessPool, graph } = dependencies;
  // Each incidence branch seeks P+1 first; the union handles a primary Work
  // also present in exact selections without scanning an entire owner's shelf.
  const inventory = (plan: IdentityPlan, after: string | null, limit: number, withState = true) => contentPool.query<Row>(`
    WITH candidates AS (
      (SELECT id FROM reader.consumption_session WHERE work=$1
        AND ($2::text IS NULL OR id COLLATE "C" > $2 COLLATE "C") ORDER BY id COLLATE "C" LIMIT $3)
      UNION
      (SELECT session AS id FROM reader.consumption_session_target WHERE resource=$1
        AND ($2::text IS NULL OR session COLLATE "C" > $2 COLLATE "C") ORDER BY session COLLATE "C" LIMIT $3)
    ) SELECT ${withState ? columns : 'id'} FROM reader.consumption_session WHERE id IN (SELECT id FROM candidates)
    ORDER BY id COLLATE "C" LIMIT $3`, [plan.source.resource, after, limit]);
  return { owner, version: 'retained-attempt-v1',
    references: ['table:reader.consumption_session.work', 'table:reader.consumption_session.state',
      'table:reader.consumption_session_target.resource'],
    cost: { page: MERGE_COST.page, callsPerItem: 128, bytesPerItem: MERGE_COST.itemBytes },
    async preview(plan) {
      const rows = await inventory(plan, null, MERGE_COST.page + 1, false);
      return { owner, count: Math.min(rows.rows.length, MERGE_COST.page), complete: rows.rows.length <= MERGE_COST.page };
    },
    async plan(task, after, limit) {
      checkedTask(task);
      if (task.plan.operation !== 'merge' || limit < 1 || limit > MERGE_COST.page) throw new InvalidMerge('Invalid attempt inventory');
      const rows = (await inventory(task.plan, after, limit + 1)).rows, kept = rows.slice(0, limit);
      return { items: kept.map(snapshot), next: rows.length > limit ? kept.at(-1)!.id : null };
    },
    async apply(task, item, commandKey): Promise<ItemOutcome> {
      checkedTask(task); checkedItem(item);
      if (task.plan.operation !== 'merge' || commandKey !== itemCommandKey(task.key, owner, item.key)
        || !Value.Check(sessionState, item.before) || item.before.id !== item.key
        || !belongs(item.before, task.plan.source.resource)) throw new InvalidMerge('Attempt receipt names another task');
      const requestDigest = mergeDigest({ task, item }), client = await contentPool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [commandKey]);
        const prior = (await client.query<{ task_key: string; request_digest: string; result: ItemOutcome }>(`
          SELECT task_key,request_digest,result FROM reader.consumption_session_merge_receipt WHERE command_key=$1`, [commandKey])).rows[0];
        if (prior) {
          if (prior.task_key !== task.key || prior.request_digest !== requestDigest) throw new MergeConflict('Attempt receipt has another intent');
          await client.query('COMMIT'); return checkedOutcome(prior.result, commandKey);
        }
        // Access locks current review/controller dependencies through Content's
        // receipt commit. A lost acknowledgement replays the Content receipt
        // before rechecking a now-terminal editorial application.
        return await controlTransaction(accessPool, async authority => {
          await checkMergeAuthority(authority, task, graph);
          const current = (await client.query<Row>(`SELECT ${columns} FROM reader.consumption_session
            WHERE id=$1 FOR SHARE`, [item.key])).rows[0];
          if (!current) throw new MergeUnavailable('Consumption attempt is unavailable');
          snapshot(current);
          if (!belongs(current.state, task.plan.source.resource)) throw new MergeUnavailable('Attempt no longer references this identity');
          const result = checkedOutcome({ outcome: 'retained', receipt: `urn:rezics:session:${commandKey}`,
            commandKey, afterHead: current.version, after: { session: current.id, work: current.work,
              reason: 'independent-exact-attempt' } }, commandKey);
          await client.query(`INSERT INTO reader.consumption_session_merge_receipt
            (command_key,task_key,request_digest,session,result) VALUES ($1,$2,$3,$4,$5)`,
          [commandKey, task.key, requestDigest, item.key, JSON.stringify(result)]);
          await client.query('COMMIT'); return result;
        });
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    compensate() { throw new InvalidMerge('Retained exact attempts have no moved item to compensate'); },
  };
}

export const mergeHandlerModule = { owner, create: sessionMergeHandler };
