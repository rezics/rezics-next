import { expect, test } from 'bun:test';
import { createDynamicCollectionsDriver } from './support/native-dynamic-driver.ts';
import { json, requestKey } from './support/native-conformance.ts';
import { createNativeZoneCollectionFixture, removeCollectionMount } from './support/native-zone-collection-fixture.ts';

test('removing one real Zone mount preserves editable curated duplicate occurrences and another mounted view', async () => {
  const driver = await createDynamicCollectionsDriver();
  try {
    const repeated = await driver.provisionSubject('game');
    const second = await driver.provisionSubject('recipe');
    const fixture = await createNativeZoneCollectionFixture(driver, repeated.id, second.id);
    const list = async <T>(path: string) =>
      json<T>(await driver.request('owner', { method: 'GET', path }));

    expect((await list<{ subjects: unknown[] }>(`/v1/zones/${fixture.removedZoneId}/subjects`)).subjects).toHaveLength(2);
    expect((await list<{ collections: unknown[] }>(`/v1/zones/${fixture.retainedZoneId}/collections`)).collections).toHaveLength(1);
    await json(
      await removeCollectionMount(driver.request, fixture.removedZoneId, fixture.collectionId),
      200,
    );

    expect((await list<{ subjects: unknown[] }>(`/v1/zones/${fixture.removedZoneId}/subjects`)).subjects).toEqual([]);
    expect((await list<{ collections: unknown[] }>(`/v1/zones/${fixture.removedZoneId}/collections`)).collections).toEqual([]);
    expect((await list<{ subjects: unknown[] }>(`/v1/zones/${fixture.retainedZoneId}/subjects`)).subjects).toHaveLength(2);

    const saved = await list<{ collection: { id: string; memberCount: number } }>(`/v1/collections/${fixture.collectionId}`);
    expect(saved.collection).toMatchObject({ id: fixture.collectionId, memberCount: 3 });
    const members = await list<{
      members: { id: string; subjectId: string; note: string | null }[];
    }>(`/v1/collections/${fixture.collectionId}/members`);
    expect(members.members.map(({ id, subjectId, note }) => ({ id, subjectId, note }))).toEqual(
      fixture.occurrences.map(({ id, subjectId, note }) => ({ id, subjectId, note })),
    );

    const edited = await json<{ member: { id: string; note: string } }>(
      await driver.request('owner', {
        method: 'PATCH',
        path: `/v1/collections/${fixture.collectionId}/members/${fixture.occurrences[0]!.id}`,
        body: { note: 'edited after unmount' },
        headers: { 'Idempotency-Key': requestKey() },
      }),
      200,
    );
    expect(edited.member).toMatchObject({ id: fixture.occurrences[0]!.id, note: 'edited after unmount' });
  } finally {
    await driver.close();
  }
});
