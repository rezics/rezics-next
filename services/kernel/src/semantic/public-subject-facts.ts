/** Public visible-subject type and label reads for Access identity presentation. */
import type { Pool, PoolClient } from 'pg';
import { chooseLabel, languageRanges } from '@rezics/definitions';
import { partitionOf, routeOf } from '../route/route.ts';
import readLabelsStatement from './read-labels.sql';
import readTypesStatement from './read-item-types.sql';
import readSubjectStatesStatement from './subject-summary-states.sql';

const BATCH_LIMIT = 256;

type Queryable = Pick<Pool | PoolClient, 'query'>;

export type ItemTypeDetails = {
  type: string;
  agentAccountId: string | null;
  agentVerified: boolean;
};

function listed<T>(result: T[] | T | null): T[] {
  if (result == null) return [];
  return Array.isArray(result) ? result : [result];
}

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

/** Unlocalized projection keys use the shared label rule without reader or original-language preferences. */
export function subjectLabel(labels: Record<string, string>, language?: string): string {
  return chooseLabel(labels, languageRanges(null, language))?.value ?? '';
}

/** Item targets of one write, one primary-key probe per id and one statement per partition. */
export async function readItemDetails(
  client: Queryable,
  ids: readonly string[],
): Promise<Map<string, ItemTypeDetails>> {
  if (ids.length > BATCH_LIMIT + 1) throw new TypeError('An item type and account agent check accepts at most 257 ids');
  const details = new Map<string, ItemTypeDetails>();
  for (const [partition, subjectIds] of groupsOf(ids)) {
    const result = (await readTypesStatement.run(client, {
      partition_no: partition,
      routes: subjectIds.map((id) => routeOf(id)!),
      subject_ids: subjectIds,
    })) as
      | { id: string; type: string; agent_account_id: string | null; agent_verified: boolean }[]
      | { id: string; type: string; agent_account_id: string | null; agent_verified: boolean }
      | null;
    const rows = result == null ? [] : Array.isArray(result) ? result : [result];
    for (const row of rows)
      details.set(row.id, {
        type: row.type,
        agentAccountId: row.agent_account_id,
        agentVerified: row.agent_verified,
      });
  }
  return details;
}

export async function readItemTypes(client: Queryable, ids: readonly string[]): Promise<Map<string, string>> {
  assertBatch(ids, 'An item type check accepts at most 256 ids');
  const details = await readItemDetails(client, ids);
  return new Map([...details].map(([id, detail]) => [id, detail.type]));
}

export type SubjectPageState = {
  id: string;
  visibility: string;
  securityRevision: string;
  redirect: string | null;
  revision: number;
};

/** Current native identity and revision fences for one display-home batch. */
export async function readSubjectPageStates(
  client: Queryable,
  home: number,
  ids: readonly string[],
): Promise<SubjectPageState[]> {
  if (!ids.length) return [];
  assertBatch(ids, 'A page-state batch accepts at most 256 ids');
  return listed(
    await readSubjectStatesStatement.run(client, {
      partition_no: home,
      routes: ids.map((id) => routeOf(id)!),
      subject_ids: [...ids],
    }),
  ) as SubjectPageState[];
}

export async function readLabels(
  pool: Queryable,
  ids: readonly string[],
): Promise<Map<string, Record<string, string>>> {
  assertBatch(ids, 'A label fill accepts at most 256 ids');
  const labels = new Map<string, Record<string, string>>();
  await Promise.all(
    [...groupsOf(ids)].map(async ([partition, subjectIds]) => {
      const rows = listed(
        (await readLabelsStatement.run(pool, {
          partition_no: partition,
          routes: subjectIds.map((id) => routeOf(id)!),
          subject_ids: subjectIds,
        })) as { id: string; labels: Record<string, string> }[] | { id: string; labels: Record<string, string> } | null,
      );
      for (const row of rows) labels.set(row.id, row.labels ?? {});
    }),
  );
  return labels;
}

export async function readPublicSubject(
  client: Queryable,
  subjectId: string,
): Promise<{ id: string; label: string; type: string } | null> {
  const [labels, types] = await Promise.all([readLabels(client, [subjectId]), readItemTypes(client, [subjectId])]);
  const labelSet = labels.get(subjectId);
  const type = types.get(subjectId);
  const label = labelSet ? subjectLabel(labelSet) : '';
  return type && label ? { id: subjectId, label, type } : null;
}
