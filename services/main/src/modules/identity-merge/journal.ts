import type { Pool, PoolClient } from 'pg';
import { canonicalCandidate, revisionOperationKey, type Json } from '../editorial-review/contract.ts';
import { checkedItem, checkedOutcome, checkedPlan, InvalidMerge, MERGE_COST, mergeDigest,
  itemCommandKey, MergeConflict, MergePending, MergeUnavailable, type MergeItem, type MergeTask, type RecordedItem,
  type ItemOutcome, type OwnerCheckpoint, type OwnerPage, type TaskCompletion } from './contract.ts';

export interface MergeJournalScope {
  task(): Promise<MergeTask | null>;
  prepare(task: MergeTask): Promise<void>;
  checkpoint(owner: string): Promise<OwnerCheckpoint>;
  pending(owner: string, limit: number): Promise<RecordedItem[]>;
  capture(owner: string, checkpoint: OwnerCheckpoint, page: OwnerPage): Promise<void>;
  record(owner: string, key: string, result: ItemOutcome): Promise<void>;
  original(key: string): Promise<MergeTask>;
  originalItem(key: string, owner: string, item: string): Promise<RecordedItem>;
  compensationPage(original: string, owner: string, after: string | null, limit: number): Promise<OwnerPage>;
  completion(): Promise<TaskCompletion | null>;
  finish(completion: TaskCompletion): Promise<void>;
}
export interface MergeJournal {
  locked<T>(key: string, operation: (scope: MergeJournalScope) => Promise<T>): Promise<T>;
}

export function checkedTask(task: MergeTask): MergeTask {
  const key = /^editorial:([0-9a-f-]{36}):([1-9][0-9]*)$/.exec(task.key);
  if (!key || revisionOperationKey(key[1]!, Number(key[2])) !== task.key
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(task.application)
    || !task.dataEpoch || task.dataEpoch.length > 512
    || mergeDigest(checkedPlan(task.plan)) !== task.candidateDigest
    || !Array.isArray(task.handlers) || !task.handlers.length || task.handlers.length > MERGE_COST.owners
    || new Set(task.handlers.map(handler => handler.owner)).size !== task.handlers.length
    || task.handlers.some(handler => !/^[a-z][a-z0-9-]{0,63}$/.test(handler.owner)
      || !/^[a-zA-Z0-9._-]{1,64}$/.test(handler.version))) throw new InvalidMerge('Invalid retained merge task');
  canonicalCandidate(task, { bytes: MERGE_COST.taskBytes, depth: 40 });
  return task;
}

export function checkedPage(page: OwnerPage, after: string | null, limit: number = MERGE_COST.page): OwnerPage {
  if (!page || !Array.isArray(page.items) || page.items.length > limit
    || page.next !== null && (typeof page.next !== 'string' || !page.next.length)
    || !page.items.length && page.next !== null) throw new InvalidMerge('Invalid owner inventory page');
  let previous = after;
  for (const item of page.items) {
    checkedItem(item);
    // PostgreSQL COLLATE C and JavaScript differ for non-ASCII UTF-16 order.
    // Buffer comparison follows the retained UTF-8 byte sequence in both owners.
    if (previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(item.key)) >= 0) {
      throw new InvalidMerge('Owner inventory did not advance');
    }
    previous = item.key;
  }
  if (page.next !== null && page.next !== page.items.at(-1)?.key) {
    throw new InvalidMerge('Owner cursor does not name the last retained item');
  }
  return page;
}

interface TaskRow { task_key: string; application: string; candidate_digest: string;
  plan: MergeTask['plan']; data_epoch: string; handlers: MergeTask['handlers'] }
interface ItemRow { item_key: string; owner: string; expected_head: string | null;
  before_state: string; snapshot_digest: string; outcome: ItemOutcome['outcome'] | null;
  command_key: string | null; receipt: string | null; after_head: string | null;
  after_state: string | null; result_digest: string | null }
const itemColumns = `i.item_key,i.owner,i.expected_head,i.before_state,i.snapshot_digest,
  o.outcome,o.command_key,o.receipt,o.after_head,o.after_state,o.result_digest`;
function itemRow(row: ItemRow): RecordedItem {
  const item: MergeItem = { key: row.item_key, expectedHead: row.expected_head,
    before: JSON.parse(row.before_state) as Json };
  checkedItem(item);
  if (mergeDigest(item) !== row.snapshot_digest) throw new MergeUnavailable('Merge item snapshot differs');
  let result: ItemOutcome | null = null;
  if (row.outcome) {
    result = checkedOutcome({ outcome: row.outcome, commandKey: row.command_key!, receipt: row.receipt!,
      afterHead: row.after_head, after: JSON.parse(row.after_state!) as Json }, row.command_key!);
    if (mergeDigest(result) !== row.result_digest) throw new MergeUnavailable('Merge item receipt differs');
  }
  return { ...item, owner: row.owner, result };
}
function taskRow(row: TaskRow): MergeTask {
  return checkedTask({ key: row.task_key, application: row.application, candidateDigest: row.candidate_digest,
    plan: row.plan, dataEpoch: row.data_epoch, handlers: row.handlers });
}

/** Session advisory lock covers cross-owner delivery, without holding a SQL
 * transaction across the network. A killed process releases it; the immutable
 * prestate and owner-native command key resolve the uncertain delivery.
 * https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS */
export class AccessMergeJournal implements MergeJournal {
  constructor(private readonly pool: Pool) {}
  async locked<T>(key: string, operation: (scope: MergeJournalScope) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let locked = false, discard = false;
    try {
      await client.query("SET statement_timeout = '5s'");
      const row = (await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`identity-merge:${key}`])).rows[0];
      if (!row?.locked) throw new MergePending('Merge task is already running');
      locked = true;
      return await operation(this.scope(key, client));
    } finally {
      try {
        await client.query('ROLLBACK');
        if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`identity-merge:${key}`]);
        await client.query('RESET statement_timeout');
      } catch { discard = true; }
      client.release(discard);
    }
  }
  private scope(key: string, client: PoolClient): MergeJournalScope {
    const transaction = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '2s'");
        if (!(await client.query('SELECT 1 FROM access.recovery_fence WHERE id AND open FOR SHARE')).rowCount) {
          throw new MergeUnavailable('Access recovery is held');
        }
        const result = await work(); await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    };
    const load = async (taskKey: string) => {
      const row = (await client.query<TaskRow>('SELECT * FROM access.identity_merge_task WHERE task_key = $1', [taskKey])).rows[0];
      return row ? taskRow(row) : null;
    };
    const completion = async (taskKey = key) => {
      const row = (await client.query<{ receipt: string; command_key: string; result: string }>(
        'SELECT * FROM access.identity_merge_completion WHERE task_key = $1', [taskKey])).rows[0];
      return row ? { receipt: row.receipt, commandKey: row.command_key, result: JSON.parse(row.result) as Json } : null;
    };
    const checkpoint = async (owner: string): Promise<OwnerCheckpoint> => {
      const row = (await client.query<{ next_key: string | null; exhausted: boolean; page: number }>(
        `SELECT next_key,exhausted,page FROM access.identity_merge_page
         WHERE task_key = $1 AND owner = $2 ORDER BY page DESC LIMIT 1`, [key, owner])).rows[0];
      return row ? { after: row.next_key, exhausted: row.exhausted, page: row.page }
        : { after: null, exhausted: false, page: 0 };
    };
    const pending = async (owner: string, limit: number) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MERGE_COST.page) throw new InvalidMerge('Invalid item page size');
      const current = await checkpoint(owner);
      const rows = await client.query<ItemRow>(`SELECT ${itemColumns} FROM access.identity_merge_item i
        LEFT JOIN access.identity_merge_item_outcome o USING (task_key,owner,item_key)
        WHERE i.task_key = $1 AND i.owner = $2 AND i.page = $3 AND o.item_key IS NULL
        ORDER BY i.item_key COLLATE "C" LIMIT $4`, [key, owner, current.page, limit]);
      return rows.rows.map(itemRow);
    };
    const scope: MergeJournalScope = {
      task: () => load(key), checkpoint, pending, completion,
      async prepare(task) {
        checkedTask(task);
        if (task.key !== key) throw new MergeConflict('Task belongs to another journal lock');
        await transaction(async () => {
          const old = await load(key);
          if (old) {
            if (mergeDigest(old) !== mergeDigest(task)) throw new MergeConflict('Merge decision binds another task');
            return;
          }
          await client.query(`INSERT INTO access.identity_merge_task
            (task_key,application,candidate_digest,plan,data_epoch,handlers,original_key) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [key, task.application, task.candidateDigest, JSON.stringify(task.plan), task.dataEpoch,
            JSON.stringify(task.handlers), task.plan.operation === 'unmerge' ? task.plan.original : null]);
        });
      },
      async capture(owner, expected, page) {
        checkedPage(page, expected.after);
        await transaction(async () => {
          const current = await checkpoint(owner);
          if (mergeDigest(current) !== mergeDigest(expected) || current.exhausted || (await pending(owner, 1)).length) {
            throw new MergeConflict('Merge inventory page is stale or still has pending deliveries');
          }
          const n = current.page + 1;
          await client.query(`INSERT INTO access.identity_merge_page (task_key,owner,page,after_key,next_key,exhausted)
            VALUES ($1,$2,$3,$4,$5,$6)`, [key, owner, n, current.after, page.next, page.next === null]);
          for (const item of page.items) await client.query(`INSERT INTO access.identity_merge_item
            (task_key,owner,item_key,page,expected_head,before_state,snapshot_digest) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [key, owner, item.key, n, item.expectedHead, JSON.stringify(item.before), mergeDigest(item)]);
        });
      },
      async record(owner, itemKey, result) {
        checkedOutcome(result, itemCommandKey(key, owner, itemKey));
        await transaction(async () => {
          const old = (await client.query<{ result_digest: string }>(`SELECT result_digest FROM access.identity_merge_item_outcome
            WHERE task_key = $1 AND owner = $2 AND item_key = $3`, [key, owner, itemKey])).rows[0];
          if (old) {
            if (old.result_digest !== mergeDigest(result)) throw new MergeConflict('Merge item binds another owner outcome');
            return;
          }
          await client.query(`INSERT INTO access.identity_merge_item_outcome
            (task_key,owner,item_key,outcome,command_key,receipt,after_head,after_state,result_digest)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [key, owner, itemKey, result.outcome,
            result.commandKey, result.receipt, result.afterHead, JSON.stringify(result.after), mergeDigest(result)]);
        });
      },
      async original(originalKey) {
        const task = await load(originalKey);
        if (!task || task.plan.operation !== 'merge' || !await completion(originalKey)) {
          throw new InvalidMerge('Unmerge requires a completed original merge');
        }
        return task;
      },
      async originalItem(originalKey, owner, itemKey) {
        const row = (await client.query<ItemRow>(`SELECT ${itemColumns} FROM access.identity_merge_item i
          JOIN access.identity_merge_item_outcome o USING (task_key,owner,item_key)
          WHERE i.task_key = $1 AND i.owner = $2 AND i.item_key = $3`, [originalKey, owner, itemKey])).rows[0];
        if (!row) throw new MergeUnavailable('Original merge item is unavailable');
        return itemRow(row);
      },
      async compensationPage(original, owner, after, limit) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MERGE_COST.page) throw new InvalidMerge('Invalid compensation page size');
        const rows = (await client.query<ItemRow>(`SELECT ${itemColumns} FROM access.identity_merge_item_outcome o
          JOIN access.identity_merge_item i USING (task_key,owner,item_key)
          WHERE o.task_key = $1 AND o.owner = $2 AND o.outcome IN ('moved','history')
            ${after === null ? '' : 'AND o.item_key > $4 COLLATE "C"'}
          ORDER BY o.item_key COLLATE "C" LIMIT $3`, [original, owner, limit + 1, ...(after === null ? [] : [after])])).rows;
        const kept = rows.slice(0, limit).map(itemRow);
        return { items: kept.map(item => ({ key: item.key, expectedHead: item.result!.afterHead,
          before: { original, owner, key: item.key,
            snapshotDigest: mergeDigest({ key: item.key, expectedHead: item.expectedHead, before: item.before }),
            outcomeDigest: mergeDigest(item.result) } })), next: rows.length > limit ? kept.at(-1)!.key : null };
      },
      async finish(result) {
        if (!result || result.commandKey !== itemCommandKey(key, 'identity-merge', '$finalize')
          || !result.receipt || result.receipt.length > 512) throw new InvalidMerge('Invalid completion receipt');
        canonicalCandidate(result, { bytes: MERGE_COST.taskBytes, depth: 40 });
        await transaction(async () => {
          const old = await completion();
          if (old) {
            if (mergeDigest(old) !== mergeDigest(result)) throw new MergeConflict('Task has another completion receipt');
            return;
          }
          await client.query(`INSERT INTO access.identity_merge_completion (task_key,receipt,command_key,result)
            VALUES ($1,$2,$3,$4)`, [key, result.receipt, result.commandKey, JSON.stringify(result.result)]);
        });
      },
    };
    return scope;
  }
}
