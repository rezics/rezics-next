import type { FakeRoute } from '../fake-modules.ts';

const stamp = '2026-10-01T00:00:00.000Z';
const rows = [
  { id: 'settings-collection-1', title: 'Books to revisit', visibility: 'private' as const, revision: 3 },
  {
    id: 'settings-collection-conflict',
    title: 'An unusually long Collection title that should wrap cleanly across the available settings column',
    visibility: 'public' as const,
    revision: 9,
  },
  { id: 'settings-collection-3', title: 'Weekend reading', visibility: 'unlisted' as const, revision: 2 },
];
const record = (row: (typeof rows)[number]) => ({
  ...row,
  description: null,
  curatorAccountId: 'story-viewer',
  state: 'active',
  memberCount: 0,
  orderEpoch: 0,
  createdAt: stamp,
  updatedAt: stamp,
});

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/accounts\/story-viewer\/collections$/,
    story: ({ request }) => {
      const url = new URL(request.url);
      const cursor = url.searchParams.get('cursor');
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 100);
      const start = cursor === 'settings-page-2' ? 2 : 0;
      const collections = rows.slice(start, start + limit).map(record);
      return { status: 200, collections, next: start === 0 && rows.length > limit ? 'settings-page-2' : null };
    },
    fixture: ({ request }) => {
      const url = new URL(request.url);
      const cursor = url.searchParams.get('cursor');
      const start = cursor === 'settings-page-2' ? 2 : 0;
      return {
        status: 200,
        collections: rows.slice(start, start + 20).map(record),
        next: start === 0 ? 'settings-page-2' : null,
      };
    },
  },
  {
    method: 'PATCH',
    path: /^\/v1\/collections\/([^/]+)$/,
    story: async ({ request, match }) => {
      const row = rows.find((item) => item.id === decodeURIComponent(match![1]!));
      if (!row) return undefined;
      if (row.id === 'settings-collection-conflict')
        return { status: 409, type: 'https://rezics.com/problems/conflict', code: 'conflict' };
      const change = (await request.json()) as { revision: number; visibility: 'private' | 'unlisted' | 'public' };
      if (change.revision !== row.revision)
        return { status: 409, type: 'https://rezics.com/problems/conflict', code: 'conflict' };
      return { status: 200, collection: record({ ...row, visibility: change.visibility, revision: row.revision + 1 }) };
    },
    fixture: async ({ request, match }) => {
      const row = rows.find((item) => item.id === decodeURIComponent(match![1]!));
      if (!row) return undefined;
      const change = (await request.json()) as { revision: number; visibility: 'private' | 'unlisted' | 'public' };
      return change.revision === row.revision
        ? { status: 200, collection: record({ ...row, visibility: change.visibility, revision: row.revision + 1 }) }
        : { status: 409, type: 'https://rezics.com/problems/conflict', code: 'conflict' };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/collections\/([^/]+)$/,
    story: ({ match }) => {
      const row = rows.find((item) => item.id === decodeURIComponent(match![1]!));
      return row ? { status: 200, collection: record(row) } : undefined;
    },
    fixture: ({ match }) => {
      const row = rows.find((item) => item.id === decodeURIComponent(match![1]!));
      return row ? { status: 200, collection: record(row) } : undefined;
    },
  },
];
