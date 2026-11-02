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
const { CollectionReadMembers, CollectionMembersStatus } = await import('../src/library/collection-page');

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
      const members = 'preparing' in page ? page.members : page.filteredMembers ?? page.members;
      expect(members.map((member) => member.subject?.label)).toEqual(status === 200 ? ['Completed member'] : []);
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
test('curated filtered reads preserve canonical members and distinguish finite preparation from unavailable and empty', async () => {
  const filter = { type: { in: ['schema:Book'] } };
  for (const status of [200, 202, 503]) {
    const client = createKernelClient('https://kernel.test', { fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === '/v1/viewerActions') return Response.json({ resources: [] });
      if (url.pathname.endsWith('/members')) {
        expect(JSON.parse(url.searchParams.get('filter')!)).toEqual(filter);
        return Response.json(status === 200 ? { members: [{ kind: 'dynamic', subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000005',
          subject: { id: '0192f3a0-6c1e-7b2a-9d4e-000000000005', label: 'A prepared member', type: 'schema:Book', cover: null } }], next: null } :
          status === 202 ? { preparing: true } : { code: 'dependency_unavailable' },
        { status, headers: { 'retry-after': '2' } });
      }
      return Response.json({ collection: { id, membershipKind: 'curated', title: 'Filtered', description: null,
        curatorAccountId: 'someone-else', visibility: 'public', revision: 1, memberCount: 10,
        createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z' } });
    } });
    const page = await loadEditableCollectionPage(client, new Request(`https://rezics.test/en/collections/${id}`),
      {}, { id, filter }, 'anonymous');
    if ('preparing' in page) throw new Error('Expected the existing curated Collection page');
    expect(page.memberState).toBe(status === 200 ? 'ready' : status === 202 ? 'preparing' : 'unavailable');
    expect(page.memberCount).toBeNull();
    expect(page.members).toEqual([]);
    expect(page.publicExport).toBe(false);
    if (status === 200) {
      expect(page.filteredMembers?.map(member => member.subject?.id)).toEqual(['0192f3a0-6c1e-7b2a-9d4e-000000000005']);
      expect(page.filteredMembers?.[0]).not.toHaveProperty('id');
      expect(page.filteredMembers?.[0]).not.toHaveProperty('addedAt');
    } else {
      expect(page.filteredMembers).toEqual([]);
      if (status === 202) expect(page.retryAfterMs).toBe(2000);
    }
  }
});

test('Members recovery retains its Collection, filter and opaque cursor through read failure and preparation', async () => {
  const filter = { type: { in: ['schema:Book'] } };
  const cursor = 'opaque+/cursor==';
  const addresses: string[] = [];
  let status = 500;
  const client = createKernelClient('https://kernel.test', { fetch: async (input, init) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname.endsWith('/members')) {
      addresses.push(url.href);
      if (status === 0) throw new TypeError('Network read failed');
      return Response.json(status === 200 ? { members: [], next: null } :
        status === 202 ? { preparing: true } : { code: 'dependency_unavailable' }, { status });
    }
    return Response.json({ collection: { id, membershipKind: 'curated', title: 'Retained shell',
      description: null, curatorAccountId: 'owner', visibility: 'public', revision: 1,
      createdAt: stamp, updatedAt: stamp } });
  } });
  for (const [next, state] of [[500, 'failed'], [0, 'failed'], [503, 'unavailable'], [202, 'preparing'], [200, 'ready']] as const) {
    status = next;
    const page = await loadEditableCollectionPage(client, new Request('https://rezics.test'), {},
      { id, filter, cursor }, 'anonymous');
    if ('preparing' in page) throw new Error('Expected the retained curated shell');
    expect([page.title, page.cursor, page.filter, page.memberState]).toEqual(['Retained shell', cursor, filter, state]);
    expect(page.publicExport).toBe(false);
  }
  expect(new Set(addresses).size).toBe(1);
  expect(new URL(addresses[0]!).searchParams.get('cursor')).toBe(cursor);
});

test('Members status exposes native preparation, unavailable admission and failed reads with fenced recovery', () => {
  const markup = (state: 'preparing' | 'unavailable' | 'failed' | 'ready', disabled = false) =>
    renderToStaticMarkup(createElement(CollectionMembersStatus, { state, disabled, retrying: false, onRetry() {} }));
  expect(markup('preparing')).toContain('role="status"');
  expect(markup('unavailable')).toContain('role="alert"');
  expect(markup('failed')).not.toBe(markup('unavailable'));
  expect(markup('ready')).toBe('');
  expect(markup('preparing', true)).toContain('disabled=""');
  expect(markup('preparing')).not.toContain('disabled=""');
});
