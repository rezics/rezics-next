import { expect, test } from 'bun:test';
import { createCollectionRulesFixture } from './support/collection-rules-fixture.ts';

test('native Everything/state/Liked discovery remains immutable when saved rule editing is available', async () => {
  const f = await createCollectionRulesFixture();
  try {
    const subjectId = await f.subject('Builtin source remains independent of saved rules');
    await f.entry(subjectId);
    const path = `/v1/collections?curatorAccountId=${f.runtime.identity.ordinary.accountId}&limit=100`;
    const discovered = await f.send('GET', path);
    expect(discovered.status).toBe(200);
    const before = await discovered.json();
    expect(before.next).toBeNull();
    for (const kind of ['everything', 'state', 'liked']) {
      const builtins = before.collections.filter((value: { builtinKind?: string }) => value.builtinKind === kind);
      expect(builtins.length).toBeGreaterThan(0);
      for (const collection of builtins) {
        expect(collection.membershipKind).toBe('dynamic');
        expect(collection.revision).toBe(0);
        const edit = await f.send('PUT', `/v1/collections/${collection.id}/rule`, {
          revision: 0,
          filter: { not: { owner: { presence: true } } },
        });
        expect(edit.status).toBe(409);
        expect(await edit.json()).toMatchObject({ code: 'dynamic_membership_immutable' });
        const hidden = await f.send(
          'PUT',
          `/v1/collections/${collection.id}/rule`,
          {
            revision: 0,
            filter: { owner: { presence: true } },
          },
          f.other,
        );
        expect(hidden.status).toBe(404);
      }
    }
    const everything = before.collections.find((value: { builtinKind?: string }) => value.builtinKind === 'everything');
    expect((await f.page(everything.id)).members).toContainEqual({ kind: 'dynamic', subjectId });
    const after = await f.send('GET', path);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual(before);
  } finally {
    await f.close();
  }
}, 120_000);
