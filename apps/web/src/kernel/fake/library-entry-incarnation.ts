import type { FakeRoute } from '../fake-modules.ts';

const entryId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const incarnationId = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const entry = {
  subjectId: entryId,
  incarnationId,
  state: 'planned',
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  subject: { id: entryId, label: 'Guarded entry', type: 'book' },
};
const conflict = { status: 409, code: 'conflict', effect_status: 'not_applied' };

/** Story fixture for guarded Library entry reads and stale-incarnation refusals. */
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: `/v1/libraryEntries/${entryId}`,
    story: () => ({ status: 200, libraryEntry: entry }),
  },
  {
    method: 'GET',
    path: '/v1/libraryEntries',
    story: ({ request, recordings }) => {
      const url = new URL(request.url);
      const recorded = recordings['library-entries'];
      if (!recorded || !Array.isArray(recorded.libraryEntries)) return undefined;
      // Keep the existing stories' subjects and states while exercising the new read field.
      const rows = recorded.libraryEntries.filter(
        (row) => !url.searchParams.get('state') || row.state === url.searchParams.get('state'),
      );
      return { ...recorded, libraryEntries: rows.map((row) => ({ ...row, incarnationId })) };
    },
  },
  {
    method: 'PUT',
    path: `/v1/libraryEntries/${entryId}`,
    story: async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as { incarnationId?: unknown; state?: string };
      if (body.incarnationId !== undefined && body.incarnationId !== incarnationId) return conflict;
      return { status: 200, libraryEntry: { ...entry, revision: 2, state: body.state ?? entry.state } };
    },
  },
  {
    method: 'DELETE',
    path: `/v1/libraryEntries/${entryId}`,
    story: ({ request }) => {
      const url = new URL(request.url);
      const guard = url.searchParams.get('incarnationId');
      return guard === null || guard === incarnationId ? { status: 204 } : conflict;
    },
  },
];
