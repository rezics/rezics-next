import type { Pool, PoolClient } from 'pg';
import { t } from 'elysia';
import { Value } from 'typebox/value';
import type { Static } from 'typebox';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { canonicalCandidate } from '../editorial-review/contract.ts';
import { controlTransaction } from '../access/topology-control.ts';
import { checkMergeAuthority } from '../identity-merge/authority.ts';
import { checkedItem, checkedOutcome, InvalidMerge, itemCommandKey, MERGE_COST, mergeDigest, MergeConflict,
  type IdentityPlan, type ItemOutcome, type MergeHandler, type MergeItem, type MergeTask, type RecordedItem } from '../identity-merge/contract.ts';
import { checkedTask } from '../identity-merge/journal.ts';
import { targetRef } from '../target/contract.ts';
import { ReaderLibraryStatusStore } from './status.ts';

export interface LibraryMergeDependencies { contentPool: Pool; accessPool: Pool; graph: Pick<FusekiClient, 'query'> }
const rowSchema = t.Object({ work: targetRef, status: t.Union([t.Null(), t.Literal('want-to-read'), t.Literal('reading'), t.Literal('read')]),
  startedOn: t.Nullable(t.String()), finishedOn: t.Nullable(t.String()), version: t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  changedAt: t.String(), sessionProjection: t.Nullable(targetRef) }, { additionalProperties: false });
type Row = Static<typeof rowSchema>;
const snapshotSchema = t.Object({ source: rowSchema, survivor: t.Nullable(rowSchema) }, { additionalProperties: false });
type Snapshot = Static<typeof snapshotSchema>;
const owner = 'library';
const columns = `work,status,started_on::text AS "startedOn",finished_on::text AS "finishedOn",
  version::text AS version,changed_at::text AS "changedAt",session_projection AS "sessionProjection"`;
const json = (value: unknown) => canonicalCandidate(value).candidate;
function row(raw: Omit<Row, 'version'> & { version: string }): Row {
  const value = { ...raw, version: Number(raw.version) };
  if (!Value.Check(rowSchema, value)) throw new MergeConflict('Library slot state is invalid');
  return value;
}
async function read(client: PoolClient, agent: string, source: string, survivor: string) {
  const rows = (await client.query<Omit<Row, 'version'> & { version: string }>(`SELECT ${columns} FROM reader.library_status
    WHERE agent=$1 AND work=ANY($2::text[]) ORDER BY work COLLATE "C" FOR UPDATE`, [agent, [source, survivor]])).rows.map(row);
  return { source: rows.find(row => row.work === source) ?? null, survivor: rows.find(row => row.work === survivor) ?? null };
}
function before(task: MergeTask, item: MergeItem): Snapshot {
  checkedTask(task); checkedItem(item);
  if (!Value.Check(targetRef, item.key) || !Value.Check(snapshotSchema, item.before)
    || item.before.source.work !== task.plan.source.resource || String(item.before.source.version) !== item.expectedHead
    || item.before.survivor && item.before.survivor.work !== task.plan.survivor.resource) throw new InvalidMerge('Library item differs');
  return item.before;
}

/** Status/date/session CAS and metadata hydration remain in the native library
 * command. Derived title/rating keys are not copied from the source or treated
 * as personal edits during compensation. A survivor slot always wins. */
export function libraryMergeHandler({ contentPool, accessPool, graph }: LibraryMergeDependencies): MergeHandler<LibraryMergeDependencies> {
  const store = new ReaderLibraryStatusStore(contentPool);
  const inventory = async (plan: IdentityPlan, after: string | null, limit: number) =>
    (await contentPool.query<{ agent: string }>(`SELECT agent FROM reader.library_status WHERE work=$1
      AND ($2::text IS NULL OR agent COLLATE "C" > $2 COLLATE "C") ORDER BY agent COLLATE "C" LIMIT $3`,
    [plan.source.resource, after, limit])).rows;
  const deliver = async (task: MergeTask, item: MergeItem, key: string,
    original?: RecordedItem & { result: ItemOutcome }): Promise<ItemOutcome> => {
    const saved = before(task, item);
    if (key !== itemCommandKey(task.key, owner, item.key) || task.plan.operation !== (original ? 'unmerge' : 'merge')) {
      throw new InvalidMerge('Library command differs');
    }
    const cleanItem = { key: item.key, expectedHead: item.expectedHead, before: item.before };
    const digest = mergeDigest({ task, item: cleanItem, original: original ?? null }), client = await contentPool.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='2s'"); await client.query("SET LOCAL statement_timeout='5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      const old = (await client.query<{ task_key: string; request_digest: string; result: ItemOutcome }>(
        'SELECT task_key,request_digest,result FROM reader.library_status_merge_receipt WHERE command_key=$1', [key])).rows[0];
      if (old) {
        if (old.task_key !== task.key || old.request_digest !== digest) throw new MergeConflict('Library receipt differs');
        await client.query('COMMIT'); return checkedOutcome(old.result, key);
      }
      return await controlTransaction(accessPool, async authority => {
        await checkMergeAuthority(authority, task, graph, owner);
        if (original && task.plan.operation === 'unmerge') {
          const retained = (await client.query<{ result: ItemOutcome }>(`SELECT result FROM reader.library_status_merge_receipt
            WHERE task_key=$1 AND agent=$2 AND command_key=$3`, [task.plan.original, item.key,
          itemCommandKey(task.plan.original, owner, item.key)])).rows[0];
          const snapshot = (await authority.query<{ snapshot_digest: string }>(`SELECT snapshot_digest FROM access.identity_merge_item
            WHERE task_key=$1 AND owner='library' AND item_key=$2`, [task.plan.original, item.key])).rows[0];
          if (!retained || mergeDigest(retained.result) !== mergeDigest(original.result)
            || snapshot?.snapshot_digest !== mergeDigest(cleanItem)) throw new InvalidMerge('Library compensation is not retained');
        }
        // Use the same lock keys and stable ordering as ordinary library writes.
        for (const work of [task.plan.source.resource, task.plan.survivor.resource].sort()) await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['library-status-work', item.key, work])]);
        const current = await read(client, item.key, task.plan.source.resource, task.plan.survivor.resource);
        let outcome: ItemOutcome['outcome'];
        const write = async (work: string, desired: Row | null, version: number, suffix: string) => {
          await store.write({ agent: item.key, work, status: desired?.status ?? null,
            startedOn: desired?.startedOn ?? null, finishedOn: desired?.finishedOn ?? null, expectedVersion: version,
            ...(desired?.sessionProjection ? { sessionProjection: desired.sessionProjection } : {}),
            idempotencyKey: `${key}:${suffix}` }, client);
        };
        if (original) {
          if (original.owner !== owner || !Value.Check(snapshotSchema, original.result.after)
            || original.result.afterHead !== mergeDigest(original.result.after)) throw new InvalidMerge('Library compensation receipt differs');
          if (!current.source || mergeDigest(current) !== original.result.afterHead) outcome = 'ambiguous';
          else {
            await write(task.plan.source.resource, saved.source, current.source.version, 'source');
            if (!saved.survivor) await write(task.plan.survivor.resource, null, current.survivor!.version, 'survivor');
            outcome = 'moved';
          }
        } else {
          // A personal edit after page capture wins over the saved merge plan.
          if (!current.source || mergeDigest(current) !== mergeDigest(saved) || saved.source.status === null) outcome = 'retained';
          else {
            if (!saved.survivor) await write(task.plan.survivor.resource, saved.source, 0, 'survivor');
            await write(task.plan.source.resource, null, saved.source.version, 'source');
            outcome = saved.survivor ? 'history' : 'moved';
          }
        }
        const after = await read(client, item.key, task.plan.source.resource, task.plan.survivor.resource);
        const result = checkedOutcome({ outcome, commandKey: key, receipt: `urn:rezics:library:${key}`,
          afterHead: outcome === 'ambiguous' ? null : mergeDigest(after), after: outcome === 'ambiguous'
            ? { reason: 'library-slot-edited' } : json(after) }, key);
        await client.query(`INSERT INTO reader.library_status_merge_receipt(command_key,task_key,agent,request_digest,result)
          VALUES ($1,$2,$3,$4,$5)`, [key, task.key, item.key, digest, JSON.stringify(result)]);
        await client.query('COMMIT'); return result;
      });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  return { owner, version: 'person-status-v2', references: ['table:reader.library_status.work'],
    cost: { page: MERGE_COST.page, callsPerItem: 128, bytesPerItem: MERGE_COST.itemBytes },
    async preview(plan) {
      const rows = await inventory(plan, null, MERGE_COST.page + 1);
      return { owner, count: Math.min(rows.length, MERGE_COST.page), complete: rows.length <= MERGE_COST.page };
    },
    async plan(task, after, limit) {
      checkedTask(task);
      if (task.plan.operation !== 'merge' || limit < 1 || limit > MERGE_COST.page) throw new InvalidMerge('Invalid library page');
      const rows = await inventory(task.plan, after, limit + 1), kept = rows.slice(0, limit), client = await contentPool.connect();
      try {
        // Bounded pair lookups; no private shelf scan. Planning holds no write transaction.
        const items = await Promise.all(kept.map(async ({ agent }) => {
          const slots = await read(client, agent, task.plan.source.resource, task.plan.survivor.resource);
          if (!slots.source) throw new MergeConflict('Library inventory changed');
          return checkedItem({ key: agent, expectedHead: String(slots.source.version), before: json(slots) });
        }));
        return { items, next: rows.length > limit ? kept.at(-1)!.agent : null };
      } finally { client.release(); }
    },
    apply: (task, item, key) => deliver(task, item, key), compensate: (task, item, key) => deliver(task, item, key, item),
  };
}
export const mergeHandlerModule = { owner, create: libraryMergeHandler };
