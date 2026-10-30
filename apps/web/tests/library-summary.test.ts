import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadCollectionPage } from '../src/library/reads.ts';

test('a collection presents localized subject summary labels while hidden subjects remain absent', async () => {
  const summaries = [
    { id: 'localized', type: 'book', label: { value: 'Localized title', language: 'en' } },
    { id: 'unlabeled', type: 'book', label: null },
    null,
  ];
  const paths: string[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      paths.push(path);
      if (path.endsWith('/members'))
        return Response.json({
          members: summaries.map((subject, index) => ({
            id: `member-${index}`,
            note: null,
            addedAt: '2026-04-02T15:04:05Z',
            subject,
          })),
          next: null,
        });
      return Response.json({
        collection: {
          id: 'collection',
          curatorAccountId: 'owner',
          title: 'Shelf',
          description: null,
          visibility: 'public',
          memberCount: summaries.length,
          updatedAt: '2026-04-02T15:04:05Z',
        },
      });
    }) as typeof fetch,
  });
  const page = await loadCollectionPage(client, new Request('https://web.test/collection'), {}, { id: 'collection' });
  expect(page.members.map(({ subject }) => subject)).toEqual([
    {
      id: 'localized',
      type: 'book',
      types: ['book'],
      label: { value: 'Localized title', language: 'en' },
      labelLanguage: 'en',
      cover: null,
    },
    { id: 'unlabeled', type: 'book', types: ['book'], label: 'unlabeled', cover: null },
    null,
  ]);
  expect(paths.sort()).toEqual(['/v1/collections/collection', '/v1/collections/collection/members']);
});

test('the curated collection reader rejects preparing membership instead of presenting an empty page', async () => {
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      if (new URL(new Request(input, init).url).pathname.endsWith('/members'))
        return Response.json({ preparing: true }, { status: 202 });
      return Response.json({
        collection: {
          id: 'collection',
          curatorAccountId: 'owner',
          title: 'Shelf',
          description: null,
          visibility: 'public',
          memberCount: 1,
          updatedAt: '2026-04-02T15:04:05Z',
        },
      });
    },
  });
  await expect(
    loadCollectionPage(client, new Request('https://web.test/collection'), {}, { id: 'collection' }),
  ).rejects.toThrow('Collection members are preparing');
});
