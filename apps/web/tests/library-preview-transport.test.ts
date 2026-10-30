import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadMineCollectionsForOwner } from '../src/library/mine-collections';
import collection from '../src/kernel/recorded/library-collection.json';
import members from '../src/kernel/recorded/library-collection-members.json';
import type { CollectionPreview } from '../src/library/collection-preview';

mock.module('cloudflare:workers', () => ({ env: {} }));

function transport(preview: Partial<CollectionPreview>, memberCount = collection.collection.memberCount) {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push(new Request(input, init));
        return Response.json({
          collections: [{ ...collection.collection, memberCount, ...preview }],
          next: 'signed-native-cursor',
        });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  return { client, requests };
}

const previewMembers = members.members.slice(0, 3).map(({ subjectId, subject }) => ({ subjectId, subject }));

test('preview layout reads one bounded native FULL page while ordinary navigation retains its metadata limit', async () => {
  const { client, requests } = transport({ previewStatus: 'ready', previewMembers });
  const page = await loadMineCollectionsForOwner(client, 'owner', 'Bearer current-viewer', { layout: 'previews' });
  expect(requests).toHaveLength(1);
  const url = new URL(requests[0]!.url);
  expect(url.pathname).toBe('/v1/collections');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    view: 'FULL',
    limit: '20',
    curatorAccountId: 'owner',
    preview: '3',
  });
  expect(requests[0]!.headers.get('authorization')).toBe('Bearer current-viewer');
  expect(page.collections[0]?.preview).toMatchObject({
    state: 'loaded',
    members: previewMembers.map(({ subject }) => ({ id: subject.id, label: subject.label })),
  });
  expect(page.collections[0]?.memberCount).toBe(collection.collection.memberCount);
  expect(page.collections[0]?.visibility).toBe(collection.collection.visibility);
  expect(page.next).toBe('signed-native-cursor');

  const ordinary = transport({});
  const metadata = await loadMineCollectionsForOwner(ordinary.client, 'owner', 'Bearer current-viewer');
  expect(ordinary.requests).toHaveLength(1);
  const metadataUrl = new URL(ordinary.requests[0]!.url);
  expect(metadataUrl.searchParams.get('limit')).toBe('100');
  expect(metadataUrl.searchParams.has('preview')).toBe(false);
  expect(metadata.collections[0]?.preview).toEqual({ state: 'unavailable' });
});

test('native pending discards partial previews and only native ready confirms an exhausted empty preview', async () => {
  const pending = transport({ previewStatus: 'pending', previewMembers });
  const pendingPage = await loadMineCollectionsForOwner(pending.client, 'owner', 'Bearer viewer', {
    layout: 'previews',
  });
  expect(pendingPage.collections[0]?.preview).toEqual({ state: 'preparing' });

  const ready = transport({ previewStatus: 'ready', previewMembers: [] });
  const readyPage = await loadMineCollectionsForOwner(ready.client, 'owner', 'Bearer viewer', { layout: 'previews' });
  expect(readyPage.collections[0]?.preview).toEqual({ state: 'loaded', members: [], emptyConfirmed: true });
  expect(readyPage.collections[0]?.memberCount).toBe(collection.collection.memberCount);

  const absent = transport({}, 0);
  const absentPage = await loadMineCollectionsForOwner(absent.client, 'owner', 'Bearer viewer', { layout: 'previews' });
  expect(absentPage.collections[0]?.preview).toEqual({ state: 'unavailable' });
});
