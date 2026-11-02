import { expect, test } from 'bun:test';
import { openSpaceSubjectPopulation } from '../../src/content/feed-subject-scope.ts';
import { createReactionRelayBase } from './reaction-relay-convergence-fixture.ts';

test('native Space Subject scope retains complete publication membership and rejects withdrawal and empty-page authority changes', async () => {
  const world = await createReactionRelayBase();
  try {
    const selected = world.mainTarget;
    const unrelated = await world.createRealmTarget('Unrelated population', 'public');
    const realm = await world.call('GET', `/v1/realms/${selected.realmId}`);
    expect(realm.response.status, realm.text).toBe(200);
    const spaceId = realm.value!.realm.spaceId as string;
    const deps = {
      pool: world.system.database.pool,
      access: world.system.access,
      contentAccess: world.system.access,
      tokens: world.system.tokenKeys,
    };
    const open = (id = spaceId, expected?: Parameters<typeof openSpaceSubjectPopulation>[5]) =>
      openSpaceSubjectPopulation(
        deps,
        { kind: 'anonymous' },
        id,
        Date.now() + 30_000,
        new Date().toISOString(),
        expected,
      );
    const publish = (realmId: string, subjectId: string) =>
      world.command('POST', `/v1/realms/${realmId}/publications`, { subjectId });
    const first = await publish(selected.realmId, world.conceptId);
    await publish(selected.realmId, world.schemeId);
    const scope = await open();
    const prefix = await scope.prefix(1);
    const expected = [world.conceptId, world.schemeId].sort();
    expect(prefix.subjects.map((row) => row.subjectId)).toEqual(expected.slice(0, 1));
    expect(prefix.exhausted).toBe(false);
    expect(prefix.examined).toBe(2);
    // Actual committed unrelated heads must not consume this scope's prefix or invalidate its observation.
    for (let index = 0; index < 12; index++) {
      const subject = await world.command('POST', '/v1/subjects', {
        type: 'schema:Book',
        labels: { en: `Unrelated scope book ${index}` },
      });
      await publish(unrelated.realmId, subject.subject.id);
    }
    expect((await scope.prefix(1)).subjects).toEqual(prefix.subjects);
    const reopened = await open(spaceId, scope.observation);
    const next = await reopened.prefix(1, prefix.coveredThrough);
    expect(next.subjects.map((row) => row.subjectId)).toEqual(expected.slice(1));
    expect(next.exhausted).toBe(true);
    expect(next.examined).toBe(1);
    await world.command(
      'POST',
      `/v1/realms/${selected.realmId}/publications/${world.conceptId}:withdraw`,
      undefined,
      {
        headers: { 'if-match': JSON.stringify(first.publication.publicationId) },
        expectedStatus: 200,
      },
    );
    await expect(scope.finish()).rejects.toMatchObject({ code: 'stale_cursor' });
    await expect(scope.prefix(1, prefix.coveredThrough)).rejects.toMatchObject({ code: 'stale_cursor' });
    await expect(open(spaceId, scope.observation)).rejects.toMatchObject({ code: 'stale_cursor' });
    expect((await (await open()).prefix(2)).subjects.map((row) => row.subjectId)).toEqual([world.schemeId]);
    const withheld = await world.createRealmTarget('Withheld Realm population', 'protected');
    const withheldRealm = await world.call('GET', `/v1/realms/${withheld.realmId}`, { bearer: world.author.bearer });
    expect(withheldRealm.response.status, withheldRealm.text).toBe(200);
    await expect(open(withheldRealm.value!.realm.spaceId)).rejects.toMatchObject({ code: 'stale_cursor' });
    const emptySpace = await world.command('POST', '/v1/spaces', {
      title: 'Empty population',
      summary: 'A Space without a Realm',
    });
    const emptyId = emptySpace.space.spaceId as string;
    const empty = await open(emptyId);
    expect(await empty.prefix(1)).toMatchObject({ subjects: [], exhausted: true, examined: 0 });
    await world.command(
      'PUT',
      `/v1/spaces/${emptyId}`,
      { title: 'Changed empty population' },
      { headers: { 'if-match': JSON.stringify(emptySpace.space.headRevisionId) } },
    );
    await expect(empty.finish()).rejects.toMatchObject({ code: 'stale_cursor' });
    await expect(empty.prefix(1)).rejects.toMatchObject({ code: 'stale_cursor' });
  } finally {
    await world.system.close();
  }
}, 180_000);
