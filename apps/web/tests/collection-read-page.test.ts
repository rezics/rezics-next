import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  collectionRequestVariant,
  loadDynamicMembers,
  loadEditableCollectionPage,
} from '../src/library/collection-load';
import { admitsCollectionOperation, readCollectionViewerActions } from '../src/library/collection-records';
import { collectionMemberRatio, collectionPageAddress } from '../src/library/collection-presentation';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
const { CollectionReadMembers } = await import('../src/library/collection-page');

const id = '0192f3a0-6c1e-7b2a-9d4e-000000000004';
const stamp = '2026-10-30T12:00:00.000Z';

test('Members retry provenance binds the exact filter along with Collection and cursor', () => {
  const input = { id, cursor: 'opaque+cursor', filter: { type: { in: ['schema:Book'] } } };
  const request = collectionRequestVariant(input, 'members');
  expect(collectionRequestVariant(structuredClone(input), 'members')).toBe(request);
  expect(collectionRequestVariant({ ...input, filter: { type: { in: ['schema:Movie'] } } }, 'members')).not.toBe(
    request,
  );
  expect(collectionRequestVariant({ ...input, cursor: 'another-cursor' }, 'members')).not.toBe(request);
});

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

test('Members status recovery keeps the addressed Collection, filter and cursor and clears preparing on completion', async () => {
  const filter = { type: { in: ['schema:Book'] } };
  const cursor = 'opaque+direct/cursor=';
  for (const kind of ['curated', 'dynamic'] as const) {
    for (const status of [202, 503, 200]) {
      const calls: URL[] = [];
      const client = createKernelClient('https://kernel.test', {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          expect(request.headers.has('authorization')).toBe(false);
          if (url.pathname.endsWith('/members')) {
            calls.push(url);
            return Response.json(
              status === 200
                ? {
                    members: [
                      {
                        id: 'occurrence',
                        subjectId: id,
                        note: null,
                        addedAt: stamp,
                        subject: { id, type: 'schema:Book', label: 'Completed member' },
                      },
                    ],
                    next: 'next-cursor',
                  }
                : { preparing: status === 202 },
              { status, headers: { 'Retry-After': '2' } },
            );
          }
          return Response.json({
            collection: {
              id,
              membershipKind: kind,
              title: 'Recovery',
              visibility: 'public',
              revision: 1,
              curatorAccountId: 'curator',
              memberCount: 99,
              description: null,
              createdAt: stamp,
              updatedAt: stamp,
            },
          });
        },
      });
      const input = { id, cursor, filter: structuredClone(filter), filterStatus: 'preparing' as const };
      const pending = loadEditableCollectionPage(
        client,
        new Request('https://rezics.test/collections/' + id),
        {},
        input,
        'anonymous',
      );
      // An edit while metadata is pending must not retarget the in-flight Members request.
      input.id = 'another-collection';
      input.cursor = 'another-cursor';
      input.filter.type.in[0] = 'schema:Movie';
      const page = await pending;
      expect(page).toMatchObject({ id, cursor, filter });
      expect(page.filterStatus).toBe(status === 202 ? 'preparing' : undefined);
      if ('preparing' in page) {
        expect(page.preparing).toBe(status === 202);
        expect(page.unavailable).toBe(status === 503);
        if (status === 202) expect(page.retryAfterMs).toBe(2000);
        const result = await loadDynamicMembers(client, id, cursor, {}, filter);
        const recovered = { ...page, filterStatus: 'preparing', ...result };
        expect(recovered.filterStatus).toBe(status === 202 ? 'preparing' : undefined);
      } else {
        expect(page.memberState).toBe(status === 200 ? 'ready' : status === 202 ? 'preparing' : 'unavailable');
        expect(page.memberCount).toBeNull();
      }
      expect(page.members.map((member) => member.subject?.label)).toEqual(status === 200 ? ['Completed member'] : []);
      expect(page.next).toBe(status === 200 ? 'next-cursor' : null);
      expect(calls).toHaveLength(kind === 'dynamic' ? 2 : 1);
      for (const url of calls) {
        expect(url.pathname).toBe(`/v1/collections/${id}/members`);
        expect(Object.fromEntries(url.searchParams)).toEqual({
          limit: '100',
          view: 'FULL',
          cursor,
          filter: JSON.stringify(filter),
        });
      }
    }
  }
});
