import { expect, test } from 'bun:test';
import { createCollectionRulesFixture } from './support/collection-rules-fixture.ts';

test('private saved members return useful complete pages and fence a changed owner source', async () => {
  const f = await createCollectionRulesFixture();
  try {
    const subjectIds: string[] = [];
    for (let index = 0; index < 4; index++) {
      const id = await f.subject(`Saved member journey ${index}`);
      await f.entry(id);
      subjectIds.push(id);
    }
    const created = await f.send('POST', '/v1/collections', {
      membershipKind: 'dynamic',
      title: 'Private member journey',
      visibility: 'private',
      rule: { filter: { owner: { presence: true } } },
    });
    expect(created.status).toBe(201);
    const { collection } = (await created.json()) as { collection: { id: string } };
    const path = (cursor?: string) => {
      const query = new URLSearchParams({ limit: '2' });
      if (cursor !== undefined) query.set('cursor', cursor);
      return `/v1/collections/${collection.id}/members?${query}`;
    };
    async function read(cursor?: string, bearer = f.owner) {
      const url = path(cursor);
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await f.send('GET', url, undefined, bearer);
        if (response.status !== 202) return response;
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('retry-after')).not.toBeNull();
        expect(await response.json()).toEqual({ preparing: true });
        await Bun.sleep(10);
      }
      throw new Error('Saved member page remained in preparation');
    }

    const expected = [...subjectIds].sort();
    const first = await read();
    expect(first.status).toBe(200);
    const firstPage = (await first.json()) as { members: { subjectId: string }[]; next: string | null };
    expect(firstPage.members.map(({ subjectId }) => subjectId)).toEqual(expected.slice(0, 2));
    expect(firstPage.next).toBeString();
    const deep = await read(firstPage.next!);
    expect(deep.status).toBe(200);
    const deepPage = (await deep.json()) as { members: { subjectId: string }[]; next: string | null };
    expect(deepPage.members.map(({ subjectId }) => subjectId)).toEqual(expected.slice(2));
    expect(deepPage.next).toBeNull();

    expect((await f.send('GET', path(), undefined, f.other)).status).toBe(404);
    const staleCursor = firstPage.next!;
    const added = await f.subject('Saved member after cursor');
    await f.entry(added);
    const stale = await f.send('GET', path(staleCursor));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'stale_cursor' });

    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await read(cursor);
      expect(response.status).toBe(200);
      const page = (await response.json()) as { members: { subjectId: string }[]; next: string | null };
      all.push(...page.members.map(({ subjectId }) => subjectId));
      cursor = page.next ?? undefined;
    } while (cursor !== undefined);
    expect(all).toEqual([...expected, added].sort());
  } finally {
    await f.close();
  }
}, 180_000);
