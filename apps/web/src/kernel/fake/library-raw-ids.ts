import type { FakeRoute } from '../fake-modules.ts';

const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const copyId = '0192f3a0-6c1e-7b2a-9d4e-000000000012';
const sessionId = '0192f3a0-6c1e-7b2a-9d4e-000000000013';
const rawIdsMarker = 'x-rezics-library-raw-ids';
const stamp = '2026-04-02T15:04:05.000Z';
const entry = {
  subjectId,
  state: 'profile-reading-state',
  revision: 3,
  createdAt: stamp,
  updatedAt: stamp,
  subject: { id: subjectId, type: 'book', label: 'Night watch' },
};
const copy = {
  id: copyId,
  subjectId,
  status: 'profile-copy-condition',
  revision: 2,
  location: null,
  source: null,
  acquiredOn: null,
  disposedOn: null,
  note: null,
  subject: { id: subjectId, type: 'book', label: 'Night watch' },
};
const progressSession = {
  id: sessionId,
  subjectId,
  versionSubjectId: null,
  mode: 'scalar_amount',
  unit: 'profile-reading-measure',
  total: '10',
  amount: '3',
  locator: null,
  position: null,
  completedUnitCount: 0,
  state: 'active',
  revision: 1,
  startedAt: stamp,
  completedAt: null,
  subject: { id: subjectId, type: 'book', label: 'Night watch' },
  versionSubject: null,
};

function isRawIdsRequest(context: { request: Request }): boolean {
  return context.request.headers.get(rawIdsMarker) === '1';
}

const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/libraryEntries',
    story: (context) => (isRawIdsRequest(context) ? { status: 200, libraryEntries: [entry], next: null } : undefined),
    fixture: (context) => (isRawIdsRequest(context) ? { status: 200, libraryEntries: [entry], next: null } : undefined),
  },
  {
    method: 'GET',
    path: /^\/v1\/libraryEntries\/([^/]+)$/,
    story: ({ match, ...context }) =>
      isRawIdsRequest(context) && decodeURIComponent(match![1]!) === subjectId
        ? { status: 200, libraryEntry: entry }
        : undefined,
    fixture: ({ match, ...context }) =>
      isRawIdsRequest(context) && decodeURIComponent(match![1]!) === subjectId
        ? { status: 200, libraryEntry: entry }
        : undefined,
  },
  {
    method: 'PUT',
    path: /^\/v1\/libraryEntries\/([^/]+)$/,
    story: async (context) => {
      if (!isRawIdsRequest(context) || decodeURIComponent(context.match![1]!) !== subjectId) return undefined;
      return { status: 200, libraryEntry: { ...entry, ...((await context.request.json()) as object) } };
    },
    fixture: async (context) => {
      if (!isRawIdsRequest(context) || decodeURIComponent(context.match![1]!) !== subjectId) return undefined;
      return { status: 200, libraryEntry: { ...entry, ...((await context.request.json()) as object) } };
    },
  },
  {
    method: 'DELETE',
    path: /^\/v1\/libraryEntries\/([^/]+)$/,
    story: ({ match, ...context }) =>
      isRawIdsRequest(context) && decodeURIComponent(match![1]!) === subjectId ? { status: 204 } : undefined,
    fixture: ({ match, ...context }) =>
      isRawIdsRequest(context) && decodeURIComponent(match![1]!) === subjectId ? { status: 204 } : undefined,
  },
  {
    method: 'GET',
    path: '/v1/copies',
    story: (context) => (isRawIdsRequest(context) ? { status: 200, copies: [copy], next: null } : undefined),
    fixture: (context) => (isRawIdsRequest(context) ? { status: 200, copies: [copy], next: null } : undefined),
  },
  {
    method: 'POST',
    path: '/v1/copies',
    story: async (context) =>
      isRawIdsRequest(context)
        ? { status: 201, copy: { ...copy, ...((await context.request.json()) as object) } }
        : undefined,
    fixture: async (context) =>
      isRawIdsRequest(context)
        ? { status: 201, copy: { ...copy, ...((await context.request.json()) as object) } }
        : undefined,
  },
  {
    method: 'PUT',
    path: /^\/v1\/copies\/([^/]+)$/,
    story: async (context) => {
      if (!isRawIdsRequest(context) || decodeURIComponent(context.match![1]!) !== copyId) return undefined;
      return { status: 200, copy: { ...copy, ...((await context.request.json()) as object) } };
    },
    fixture: async (context) => {
      if (!isRawIdsRequest(context) || decodeURIComponent(context.match![1]!) !== copyId) return undefined;
      return { status: 200, copy: { ...copy, ...((await context.request.json()) as object) } };
    },
  },
  {
    method: 'DELETE',
    path: /^\/v1\/copies\/([^/]+)$/,
    story: ({ match, ...context }) =>
      isRawIdsRequest(context) && decodeURIComponent(match![1]!) === copyId ? { status: 204 } : undefined,
    fixture: ({ match, ...context }) =>
      isRawIdsRequest(context) && decodeURIComponent(match![1]!) === copyId ? { status: 204 } : undefined,
  },
  {
    method: 'GET',
    path: '/v1/progressSessions',
    story: (context) =>
      isRawIdsRequest(context) ? { status: 200, progressSessions: [progressSession], next: null } : undefined,
    fixture: (context) =>
      isRawIdsRequest(context) ? { status: 200, progressSessions: [progressSession], next: null } : undefined,
  },
  {
    method: 'POST',
    path: '/v1/progressSessions',
    story: async (context) =>
      isRawIdsRequest(context)
        ? { status: 201, progressSession: { ...progressSession, ...((await context.request.json()) as object) } }
        : undefined,
    fixture: async (context) =>
      isRawIdsRequest(context)
        ? { status: 201, progressSession: { ...progressSession, ...((await context.request.json()) as object) } }
        : undefined,
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)\/collections$/,
    story: ({ match, ...context }) =>
      isRawIdsRequest(context) && decodeURIComponent(match![1]!) === subjectId
        ? { status: 200, collections: [], next: null }
        : undefined,
    fixture: ({ match, ...context }) =>
      isRawIdsRequest(context) && decodeURIComponent(match![1]!) === subjectId
        ? { status: 200, collections: [], next: null }
        : undefined,
  },
];

export { routes };
