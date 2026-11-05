import type { FakeRoute } from '../fake-modules.ts';
import { recordedBookState } from './library-entry-states.ts';

const entryId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const incarnationId = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const entry = {
  subjectId: entryId,
  incarnationId,
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
    story: ({ recordings }) => ({
      status: 200,
      libraryEntry: {
        ...entry,
        state:
          recordedBookState(0) ??
          (recordings['library-entries'] as { libraryEntries?: { state?: string }[] } | undefined)?.libraryEntries?.[0]
            ?.state,
      },
    }),
  },
  {
    method: 'GET',
    path: '/v1/libraryEntries',
    story: ({ request, recordings }) => {
      const url = new URL(request.url);
      const activeState = recordedBookState('active');
      const recorded =
        (activeState && url.searchParams.get('state') === activeState && recordings['library-continue-entries']) ||
        recordings['library-entries'];
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
      return {
        status: 200,
        libraryEntry: {
          ...entry,
          state: body.state ?? recordedBookState(0),
          revision: 2,
        },
      };
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
