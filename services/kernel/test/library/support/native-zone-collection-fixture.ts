import type { ZoneStarter } from '@rezics/composition';
import bookStarter from '../../../../../packages/definitions/presentation/book/zone.json';
import type { DynamicCollectionsDriver } from '../../../../../specs/dynamic-collections-driver.ts';
import { json, requestKey } from './native-conformance.ts';

type Request = DynamicCollectionsDriver['request'];
type Occurrence = { id: string; subjectId: string; note: string };

const configuration = (): ZoneStarter => ({
  labels: structuredClone(bookStarter.labels),
  pages: [
    {
      route: '',
      document: {
        root: { props: {} },
        content: [{ type: 'Text', props: { id: 'collection', text: 'Collection' } }],
      },
    },
  ],
  scope: [],
});

async function create<T>(request: Request, path: string, body: unknown): Promise<T> {
  return json<T>(
    await request('owner', {
      method: 'POST',
      path,
      body,
      headers: { 'Idempotency-Key': requestKey() },
    }),
    201,
  );
}

export function mountCollectionInZone(request: Request, collectionId: string): Promise<Response> {
  return request('owner', {
    method: 'POST',
    path: '/v1/zones',
    body: { configuration: configuration(), mounts: [collectionId], visibility: 'private' },
    headers: { 'Idempotency-Key': requestKey() },
  });
}

export async function createNativeZoneCollectionFixture(
  driver: DynamicCollectionsDriver,
  repeatedSubjectId: string,
  secondSubjectId: string,
) {
  const { collection } = await create<{ collection: { id: string } }>(driver.request, '/v1/collections', {
    title: 'Mounted duplicate preservation',
    visibility: 'private',
  });
  const occurrences: Occurrence[] = [];
  for (const [subjectId, note] of [
    [repeatedSubjectId, 'first occurrence'],
    [secondSubjectId, 'second member'],
    [repeatedSubjectId, 'curated duplicate'],
  ] as const) {
    const { member } = await create<{ member: Occurrence }>(
      driver.request,
      `/v1/collections/${collection.id}/members`,
      {
        subjectId,
        note,
      },
    );
    occurrences.push(member);
  }

  const removedMount = await driver.mountCollection(collection.id);
  const removedZone = await json<{ zone: { id: string } }>(removedMount, 201);
  const retainedMount = await mountCollectionInZone(driver.request, collection.id);
  const retainedZone = await json<{ zone: { id: string } }>(retainedMount, 201);
  return {
    collectionId: collection.id,
    occurrences,
    removedZoneId: removedZone.zone.id,
    retainedZoneId: retainedZone.zone.id,
  };
}

export async function removeCollectionMount(request: Request, zoneId: string, collectionId: string) {
  const current = await json<{
    zone: { revision: string | number };
    configuration: ZoneStarter;
    mounts: string[];
  }>(await request('owner', { method: 'GET', path: `/v1/zones/${zoneId}/configuration` }));
  if (!current.mounts.includes(collectionId))
    throw new Error(`Zone ${zoneId} no longer mounts Collection ${collectionId}`);
  return request('owner', {
    method: 'PUT',
    path: `/v1/zones/${zoneId}/configuration`,
    body: { configuration: current.configuration, mounts: current.mounts.filter((id) => id !== collectionId) },
    headers: {
      'If-Match': `"${current.zone.revision}"`,
      'Idempotency-Key': requestKey(),
    },
  });
}
