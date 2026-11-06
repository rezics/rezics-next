import { randomUUID } from 'node:crypto';
import { bulkLines, documentActions } from '../../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../../src/search/indices.ts';
import type { OpenSearch } from '../../../src/search/opensearch.ts';
import { FACET_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../../src/search/query.ts';
import { newId } from '../../../src/route/route.ts';
import { createSubject } from '../../../src/semantic/subject.ts';
import { subjectPartition, type IndexedSubject } from '../../../src/search/source.ts';
import { createFakeSource } from './fake-source.ts';
import { digest, release as nativeRelease, type EpochFixture } from '../../semantic/support/identity-epoch.ts';

export function executedRequestSubject(
  n: number,
  label: string,
  partition = 10,
  patch: Partial<IndexedSubject> = {},
): IndexedSubject {
  return {
    id: `018f0000-0000-7000-8000-${(partition * 16).toString(16).padStart(4, '0')}${String(n).padStart(8, '0')}`,
    type: 'schema:Book',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: label }],
    aliases: [],
    descriptions: [],
    statements: [],
    ...patch,
  };
}

/** Create the native revision-1 identity row used by canonical Search before indexing the test document. */
export async function createMappedExecutedRequestSubject(
  fixture: EpochFixture,
  n: number,
  label: string,
  partition = 10,
  patch: Partial<IndexedSubject> = {},
): Promise<IndexedSubject> {
  const route = partition * 16;
  const actor = await fixture.actor();
  const key = randomUUID();
  const created = await createSubject(fixture.pool, {
    actor,
    target: { route, id: newId(route) },
    idempotencyKey: key,
    digest: digest(key),
    item: { type: 'schema:Book', labels: { en: label } },
    release: nativeRelease,
    authorization: await fixture.authorization('subject:create'),
  });
  return { ...executedRequestSubject(n, label, partition, patch), id: created.subject.id };
}

export async function publishExecutedGeneration(
  client: OpenSearch,
  prefix: string,
  fake: ReturnType<typeof createFakeSource>,
  subjects: readonly IndexedSubject[],
  generation: number,
) {
  await createSubjectIndex(client, prefix, generation);
  const index = subjectIndexName(prefix, generation);
  const partitions = new Map<number, string[]>();
  for (const entry of subjects) {
    const partition = subjectPartition(entry.id);
    partitions.set(partition, [...(partitions.get(partition) ?? []), entry.id]);
  }
  for (const [partition, ids] of partitions) {
    const snapshot = await fake.read(partition, ids);
    await client.bulk(bulkLines(index, documentActions(snapshot, ids)), { query: { refresh: 'wait_for' } });
  }
  const { active } = await subjectGenerations(client, prefix);
  const alias = subjectAlias(prefix);
  const actions: object[] = [{ add: { index, alias } }];
  if (active !== null && active !== generation)
    actions.unshift({ remove: { index: subjectIndexName(prefix, active), alias } });
  await client.request('POST', '/_aliases', { actions });
}

export async function deleteExecutedSearchPrefix(client: OpenSearch, prefix: string) {
  const { generations } = await subjectGenerations(client, prefix);
  for (const generation of generations) await client.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
  for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
    await client.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
}
