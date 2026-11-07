import type { Pool, PoolClient } from 'pg';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { Item } from './contract/item-values.ts';
import { RELATED_SUBJECT_BATCH_LIMIT as BATCH_LIMIT } from './contract/subject-values.ts';
import readRelatedStatement from './read-related.sql';

function listed<T>(result: T[] | T | null): T[] {
  if (result == null) return [];
  return Array.isArray(result) ? result : [result];
}

type Queryable = Pick<PoolClient, 'query'>;

function assertBatch(ids: readonly string[], message: string): void {
  if (ids.length > BATCH_LIMIT) throw new TypeError(message);
}

function groupsOf(ids: readonly string[]): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const route = routeOf(id);
    if (route === null) continue;
    const partition = partitionOf(route);
    const group = groups.get(partition) ?? [];
    group.push(id);
    groups.set(partition, group);
  }
  return groups;
}

export type RelatedState = {
  id: string;
  visibility: string;
  security_revision: string;
  redirect: string | null;
  labels: Item['labels'];
};

type RelatedEpisode = { ids: string[]; pending?: Promise<Map<string, RelatedState>> };

async function queryRelated(client: Queryable, ids: readonly string[]): Promise<Map<string, RelatedState>> {
  const states = new Map<string, RelatedState>();
  for (const [partition, subjectIds] of groupsOf(ids)) {
    const rows = listed(
      (await readRelatedStatement.run(client, {
        partition_no: partition,
        routes: subjectIds.map((id) => routeOf(id)!),
        subject_ids: subjectIds,
      })) as RelatedState[] | RelatedState | null,
    );
    for (const row of rows) states.set(row.id, { ...row, labels: row.labels ?? {} });
  }
  return states;
}

/** One statement per partition for visibility, eligibility, labels and redirects. */
function loadRelatedInEpisode(
  client: object,
  ids: readonly string[],
  episode: RelatedEpisode,
): Promise<Map<string, RelatedState>> {
  assertBatch(ids, 'A related read accepts at most 256 ids');
  const known = episode.pending === undefined ? null : { ids: episode.ids, pending: episode.pending };
  if (known && ids.every((id) => known.ids.includes(id))) return known.pending;
  const pending = queryRelated(client as Queryable, ids).then(async (fetched) => {
    const prior = known ? await known.pending : new Map<string, RelatedState>();
    const merged = new Map(prior);
    for (const [id, state] of fetched) merged.set(id, state);
    return merged;
  });
  episode.ids = [...new Set([...(known?.ids ?? []), ...ids])];
  episode.pending = pending;
  return pending;
}

/** Loads current related state; callers may reuse it only within their bounded read episode. */
export function loadRelated(client: object, ids: readonly string[]): Promise<Map<string, RelatedState>> {
  assertBatch(ids, 'A related read accepts at most 256 ids');
  return queryRelated(client as Queryable, ids);
}

function isPool(value: Pool | PoolClient): value is Pool {
  return typeof (value as Pool).connect === 'function' && typeof (value as PoolClient).release !== 'function';
}

/** Labels of the requested ids, following one redirect, from this related-read episode. */
export async function readRelated(db: Pool | PoolClient, ids: readonly string[]) {
  assertBatch(ids, 'A related read accepts at most 256 ids');
  const assemble = async (client: PoolClient) => {
    const episode: RelatedEpisode = { ids: [] };
    const states = await loadRelatedInEpisode(client, ids, episode);
    const targets = [
      ...new Set(
        ids.flatMap((id) => {
          const state = states.get(id);
          return state?.visibility === 'visible' && state.redirect ? [state.redirect] : [];
        }),
      ),
    ];
    const targetStates = targets.length > 0 ? await loadRelatedInEpisode(client, targets, episode) : states;
    const related: Record<string, { labels: Item['labels']; redirect?: string }> = {};
    for (const id of ids) {
      const state = states.get(id);
      if (!state || state.visibility !== 'visible') continue;
      const target = state.redirect;
      if (target) {
        const redirected = targetStates.get(target);
        if (!redirected || redirected.visibility !== 'visible') continue;
        related[id] = { redirect: target, labels: redirected.labels };
        continue;
      }
      related[id] = { labels: state.labels };
    }
    return related;
  };
  if (isPool(db)) return withConnection(db, assemble);
  return assemble(db);
}
