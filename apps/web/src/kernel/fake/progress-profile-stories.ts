import type { NativeProgressSession } from '../../library/progress-reads';
import type { FakeRoute } from '../fake-modules';

export const manualScalarId = '0192f3a0-6c1e-7b2a-9d4e-000000000811';
export const manualSparseId = '0192f3a0-6c1e-7b2a-9d4e-000000000812';
export const manualCursorId = '0192f3a0-6c1e-7b2a-9d4e-000000000813';
export const manualUnresolvedId = '0192f3a0-6c1e-7b2a-9d4e-000000000814';
export const manualWithheldId = '0192f3a0-6c1e-7b2a-9d4e-000000000815';
export const manualVersionId = '0192f3a0-6c1e-7b2a-9d4e-000000000816';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000817';

const scalar = {
  id: manualScalarId,
  subjectId,
  versionSubjectId: manualVersionId,
  mode: 'scalar_amount',
  unit: 'page',
  total: '300',
  amount: '120.000001',
  locator: null,
  position: null,
  completedUnitCount: 0,
  state: 'active',
  revision: 2,
  startedAt: '2026-10-01T00:00:00.000Z',
  completedAt: null,
  subject: { id: subjectId, type: 'schema:Book', label: 'A manual reading session' },
  versionSubject: { id: manualVersionId, type: 'schema:Book', label: 'Selected version A' },
} satisfies NativeProgressSession;

/**
 * Constructed native-declared raw values, not permission or historic-label fixtures.
 * This base has no declared presentation body. Do not manufacture a supported state from today's release.
 */
export const manualProgressSessions: NativeProgressSession[] = [
  scalar,
  {
    ...scalar,
    id: manualSparseId,
    mode: 'completed_units',
    unit: 'chapter',
    total: null,
    amount: null,
    completedUnitCount: 3,
  },
  {
    ...scalar,
    id: manualCursorId,
    mode: 'cursor_position',
    unit: 'chapter',
    total: null,
    amount: null,
    locator: ' epubcfi(/6/2[old-chapter]) ',
    position: '12.250001',
  },
  { ...scalar, id: manualUnresolvedId, unit: 'historic-unit-x' },
  { ...scalar, id: manualWithheldId, subject: null, versionSubject: null },
];

export const manualSparseKeys = ['1', '3', '7'];

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/progressSessions\/([^/]+)$/,
    story: ({ match }) => {
      const session = manualProgressSessions.find(({ id }) => id === match?.[1]);
      return session ? { status: 200, progressSession: structuredClone(session) } : undefined;
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/progressSessions\/([^/]+)\/completedUnits$/,
    story: ({ match, request }) => {
      if (!manualProgressSessions.some(({ id }) => id === match?.[1])) return;
      if (match?.[1] !== manualSparseId) return { status: 200, completedUnits: [], next: null };
      const later = new URL(request.url).searchParams.get('cursor') === 'manual-units-next';
      return {
        status: 200,
        completedUnits: later ? manualSparseKeys.slice(2) : manualSparseKeys.slice(0, 2),
        next: later ? null : 'manual-units-next',
      };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/progressSessions\/([^/]+)\/changes$/,
    story: ({ match }) => {
      const session = manualProgressSessions.find(({ id }) => id === match?.[1]);
      if (!session) return;
      const intent =
        session.mode === 'completed_units'
          ? { add: [...manualSparseKeys] }
          : session.mode === 'cursor_position'
            ? { locator: session.locator, position: session.position }
            : { amount: session.amount };
      return {
        status: 200,
        changes: [{ id: `${session.id}:2`, revision: 2, createdAt: '2026-10-02T00:00:00.000Z', intent }],
        next: null,
      };
    },
  },
];
