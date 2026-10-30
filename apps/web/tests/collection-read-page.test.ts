import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadEditableCollectionPage } from '../src/library/collection-load';
import { admitsCollectionOperation, readCollectionViewerActions } from '../src/library/collection-records';
import { collectionMemberRatio, collectionPageAddress } from '../src/library/collection-presentation';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
const { CollectionReadMembers } = await import('../src/library/collection-page');

const id = '0192f3a0-6c1e-7b2a-9d4e-000000000004';
const stamp = '2026-10-30T12:00:00.000Z';

test('Collection read page has real owner actions, readable member rows and complete page states', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return Response.json({
        resources: [
          {
            type: 'library.collection',
            id,
            viewerActions: [{ action: 'collection:update', operations: ['collection.update'] }],
          },
        ],
      });
    },
  });
  const actions = await readCollectionViewerActions(client, id, 'Bearer current-viewer');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.method).toBe('POST');
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer current-viewer');
  expect(await calls[0]!.json()).toEqual({ resources: [{ type: 'library.collection', id }] });
  expect(admitsCollectionOperation(actions, 'collection:update', 'collection.update')).toBe(true);
  expect(admitsCollectionOperation(actions, 'collection:delete', 'collection.delete')).toBe(false);
  expect(admitsCollectionOperation(undefined, 'collection:update', 'collection.update')).toBe(false);

  const members = [
    {
      id: 'occurrence-1',
      note: 'First occurrence',
      subject: {
        id,
        label: 'A title that stays attached to its cover',
        type: 'schema:Book',
        types: ['schema:Book'],
        cover: null,
      },
    },
    {
      id: 'occurrence-2',
      note: 'Second occurrence',
      subject: {
        id,
        label: 'A title that stays attached to its cover',
        type: 'schema:Book',
        types: ['schema:Book'],
        cover: null,
      },
    },
    { id: 'hidden', note: null, subject: null },
  ];
  const html = renderToStaticMarkup(createElement(CollectionReadMembers, { members, onCopy: () => {} }));
  expect(html.match(/data-slot="member-list-row-title"/g)).toHaveLength(2);
  expect(html.match(/data-slot="list-row-link"/g)).toHaveLength(2);
  expect(html).toContain('First occurrence');
  expect(html).toContain('Second occurrence');
  expect(html).not.toContain('Type:');
  expect(html).not.toContain('text-primary');
  expect(html).not.toContain('<input');
  expect(html).not.toContain('<textarea');
  expect(collectionMemberRatio({ type: 'schema:Movie' })).toBe('16:9');
  expect(collectionMemberRatio({ type: 'custom:Bookish' }, { 'custom:Bookish': '2:3' })).toBe('2:3');

  for (const status of [200, 202, 503]) {
    const paths: string[] = [];
    const reader = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        paths.push(url.pathname);
        if (url.pathname === '/v1/viewerActions')
          return Response.json({ resources: [{ type: 'library.collection', id, viewerActions: [] }] });
        if (url.pathname.endsWith('/members')) {
          expect(url.searchParams.get('limit')).toBe('100');
          expect(url.searchParams.get('view')).toBe('FULL');
          return Response.json(status === 200 ? { members: [], next: null } : { preparing: status === 202 }, {
            status,
          });
        }
        return Response.json({
          collection: {
            id,
            membershipKind: 'curated',
            title: 'Read states',
            description: null,
            visibility: 'public',
            curatorAccountId: 'someone-else',
            curator: null,
            revision: 9,
            memberCount: 77,
            createdAt: stamp,
            updatedAt: stamp,
          },
        });
      },
    });
    const page = await loadEditableCollectionPage(
      reader,
      new Request('https://rezics.test/en/collections/' + id),
      {},
      { id },
      'anonymous',
    );
    if ('preparing' in page) throw new Error('Expected a curated page');
    expect(page.memberState).toBe(status === 200 ? 'ready' : status === 202 ? 'preparing' : 'unavailable');
    expect(page.memberCount).toBe(status === 200 ? 0 : null);
    expect(page.publicExport).toBe(status === 200);
    expect(paths).toHaveLength(3);
  }
});

test('Collection paging preserves the shell filter protocol without extra queries', () => {
  const url = new URL(
    collectionPageAddress('en', id, 'signed+cursor', {
      type: 'schema:Movie',
      'f.schema:genre': ['one', 'two'],
      'l.schema:genre': 'Two',
      'r.schema:duration': '1,90',
      query: 'not a second matcher',
    }),
    'https://rezics.test',
  );
  expect(url.searchParams.getAll('f.schema:genre')).toEqual(['one', 'two']);
  expect(url.searchParams.get('type')).toBe('schema:Movie');
  expect(url.searchParams.get('l.schema:genre')).toBe('Two');
  expect(url.searchParams.get('r.schema:duration')).toBe('1,90');
  expect(url.searchParams.get('cursor')).toBe('signed+cursor');
  expect(url.searchParams.has('query')).toBe(false);
});

test('Unavailable native action discovery never grants an owner action', async () => {
  const client = createKernelClient('https://kernel.test', {
    fetch: async () => Response.json({ code: 'dependency_unavailable' }, { status: 503 }),
  });
  const actions = await readCollectionViewerActions(client, id, null);
  expect(actions).toEqual({ state: 'unavailable' });
  expect(admitsCollectionOperation(actions, 'collection:update', 'collection.update')).toBe(false);
});
