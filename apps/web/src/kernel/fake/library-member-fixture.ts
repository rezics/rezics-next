import type { FakeRoute } from '../fake-modules';
import type { KernelRecording } from '../fake';
import entriesRecording from '../recorded/library-entries.json';
import sessionsRecording from '../recorded/library-progress-sessions.json';

export type MemberShelfState = 'populated' | 'first-use' | 'preparing' | 'unavailable';
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const labelId = id(801);
const labels = [
  { id: labelId, name: 'Reading list', revision: 1 },
  { id: id(802), name: 'Favorites', revision: 1 },
  { id: id(803), name: 'Read later', revision: 1 },
];
const states = ['all', 'in_progress', 'planned', 'completed', 'paused', 'dropped', 'collections'] as const;
const unavailable = { status: 503, code: 'unavailable', type: 'https://rezics.com/problems/unavailable' };
const preparing = {
  status: 503,
  code: 'dependency_unavailable',
  type: 'https://rezics.com/problems/dependency-unavailable',
};

/** Constructed responses for manual page review. Counts, filters and labels share this exact population. */
function memberEntries() {
  const books = entriesRecording.libraryEntries.map((row, index) => {
    const session = sessionsRecording.progressSessions.find((value) => value.subjectId === row.subjectId);
    const active = row.state === 'in_progress' || row.state === 'paused';
    return {
      ...row,
      incarnationId: id(2100 + index),
      lastActivityAt: `2026-11-${String(12 - index).padStart(2, '0')}T12:00:00Z`,
      finishedAt: row.state === 'completed' ? '2026-11-08T12:00:00Z' : null,
      subject: {
        ...row.subject,
        id: row.subjectId,
        cover: session && 'cover' in session.subject ? session.subject.cover : null,
      },
      activeProgressSession:
        active && session
          ? {
              id: session.id,
              subjectId: row.subjectId,
              versionSubjectId: session.versionSubjectId,
              mode: session.mode,
              unit: session.unit,
              amount: session.amount,
              total: session.total,
              locator: session.locator,
              position: session.position,
              completedUnitCount: session.completedUnitCount,
              state: session.state,
              revision: session.revision,
              startedAt: session.startedAt,
              completedAt: session.completedAt,
            }
          : null,
    };
  });
  const template = books[0]!;
  return [
    ...books,
    {
      ...template,
      subjectId: id(2201),
      incarnationId: id(2301),
      state: 'in_progress',
      lastActivityAt: '2026-11-06T12:00:00Z',
      subject: {
        ...template.subject,
        id: id(2201),
        type: 'schema:TVSeries',
        types: ['schema:TVSeries'],
        label: { value: 'Signals from Home', language: 'en' },
        cover: null,
      },
      activeProgressSession: {
        id: id(2601),
        subjectId: id(2201),
        versionSubjectId: null,
        mode: 'scalar_amount',
        unit: 'episode',
        amount: '4',
        total: '12',
        locator: null,
        position: null,
        completedUnitCount: 0,
        state: 'active',
        revision: 1,
        startedAt: '2026-11-01T12:00:00Z',
        completedAt: null,
      },
    },
    {
      ...template,
      subjectId: id(2202),
      incarnationId: id(2302),
      state: 'planned',
      lastActivityAt: '2026-11-05T12:00:00Z',
      subject: {
        ...template.subject,
        id: id(2202),
        type: 'schema:Movie',
        types: ['schema:Movie'],
        label: { value: 'The Last Tram', language: 'en' },
        cover: null,
      },
      activeProgressSession: null,
    },
    {
      ...template,
      subjectId: id(2203),
      incarnationId: id(2303),
      state: 'paused',
      lastActivityAt: '2026-11-04T12:00:00Z',
      subject: {
        ...template.subject,
        id: id(2203),
        type: 'schema:VideoGame',
        types: ['schema:VideoGame'],
        label: { value: 'A Map of Quiet Places', language: 'en' },
        cover: null,
      },
      activeProgressSession: null,
    },
  ];
}
type MemberEntry = ReturnType<typeof memberEntries>[number];

/** An explicit opt-in leaves recordings and private lifetime regression fixtures unchanged. */
export function createMemberShelfFixture() {
  let state: MemberShelfState | null = null;
  let titlePrepared = false;
  const population = () => (state === 'first-use' ? [] : memberEntries());
  const current = (request: Request) => {
    const query = new URL(request.url).searchParams;
    return population().filter(
      (row) =>
        (!query.get('type') || row.subject.type === query.get('type')) &&
        (!query.get('state') || row.state === query.get('state')),
    );
  };
  const page = (request: Request) => {
    const query = new URL(request.url).searchParams;
    const order = query.get('orderBy') ?? 'lastActivity';
    const direction = query.get('direction') === 'asc' ? 1 : -1;
    const value = (row: MemberEntry) =>
      order === 'title'
        ? row.subject.label.value
        : order === 'createdAt'
          ? row.createdAt
          : order === 'finishedAt'
            ? (row.finishedAt ?? '')
            : row.lastActivityAt;
    // This is the simulated HTTP producer order; the shelf never sorts a returned page.
    return current(request).sort((a, b) => direction * value(a).localeCompare(value(b)));
  };
  const entries = (request: Request): KernelRecording | undefined => {
    if (!state) return undefined;
    if (state === 'unavailable') return unavailable;
    if (state === 'preparing' && !titlePrepared) return preparing;
    return { status: 200, libraryEntries: page(request), next: null };
  };
  const summary = (request: Request): KernelRecording | undefined => {
    if (!state) return undefined;
    const all = population();
    const selected = current(request);
    return {
      status: 200,
      tabs: Object.fromEntries(
        states.map((bucket) => [
          bucket,
          {
            total: bucket === 'collections' ? 0 : all.filter((row) => bucket === 'all' || row.state === bucket).length,
            shown:
              bucket === 'collections' ? 0 : selected.filter((row) => bucket === 'all' || row.state === bucket).length,
          },
        ]),
      ),
    };
  };
  const labelAssignments = (request: Request): KernelRecording | undefined => {
    if (!state) return undefined;
    const query = new URL(request.url).searchParams;
    const target = query.get('labelId');
    const rows = population().filter((_, index) =>
      target === id(803) ? index === 3 || index === 6 : target === id(802) ? index === 4 : index < 3,
    );
    if (!target) {
      return {
        status: 200,
        assignments: labels.map((label, index) => ({
          id: id(2400 + index),
          labelId: label.id,
          subjectId: query.get('subjectId'),
          revision: 1,
          label: { name: label.name },
        })),
        next: null,
      };
    }
    return {
      status: 200,
      label: labels.find((label) => label.id === target),
      assignments: rows.map((row, index) => ({
        id: id(2500 + index),
        labelId: target,
        subjectId: row.subjectId,
        revision: 1,
        subject: row.subject,
        libraryEntry: {
          subjectId: row.subjectId,
          revision: row.revision,
          incarnationId: row.incarnationId,
          state: row.state,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          lastActivityAt: row.lastActivityAt,
          finishedAt: row.finishedAt,
          activeProgressSession: row.activeProgressSession,
        },
      })),
      next: null,
    };
  };
  const routes: FakeRoute[] = [
    {
      method: 'GET',
      path: /^\/v1\/libraryEntries\/[^/:]+$/,
      story: ({ request }) => {
        if (!state) return undefined;
        const entry = population().find((row) => new URL(request.url).pathname.endsWith(row.subjectId));
        return entry ? { status: 200, libraryEntry: entry } : undefined;
      },
    },
    { method: 'GET', path: '/v1/libraryEntries', story: ({ request }) => entries(request) },
    { method: 'GET', path: '/v1/libraryShelfSummary', story: ({ request }) => summary(request) },
    {
      method: 'GET',
      path: '/v1/libraryShelfTypes',
      story: () =>
        state
          ? {
              status: 200,
              types: [...new Set(population().map((row) => row.subject.type))].map((type) => ({
                type,
                count: population().filter((row) => row.subject.type === type).length,
              })),
              next: null,
            }
          : undefined,
    },
    {
      method: 'GET',
      path: '/v1/libraryLabels',
      story: ({ request }) =>
        state
          ? {
              status: 200,
              labels:
                state === 'first-use'
                  ? []
                  : labels.filter((label) => label.name.startsWith(new URL(request.url).searchParams.get('q') ?? '')),
              next: null,
            }
          : undefined,
    },
    {
      method: 'GET',
      path: /^\/v1\/libraryLabels\/[^/]+$/,
      story: ({ request }) =>
        state
          ? { status: 200, label: labels.find((label) => new URL(request.url).pathname.endsWith(label.id)) }
          : undefined,
    },
    { method: 'GET', path: '/v1/libraryLabelAssignments', story: ({ request }) => labelAssignments(request) },
    {
      method: 'POST',
      path: '/v1/libraryShelfTitlePreparation',
      story: () => {
        if (!state) return undefined;
        titlePrepared = true;
        return { status: 200, installation: 'installed', prepared: population().length };
      },
    },
    {
      method: 'GET',
      path: /^\/v1\/subjects\/[^/:]+$/,
      story: ({ request, recordings }) => {
        if (!state) return undefined;
        const row = population().find((entry) => new URL(request.url).pathname.endsWith(entry.subjectId));
        if (!row) return undefined;
        const recorded = recordings.subject;
        const source = recorded?.subject as Record<string, unknown> | undefined;
        if (!source) return undefined;
        return {
          ...recorded,
          status: 200,
          related: [],
          summary: { ...row.subject, creativeWork: true },
          subject: {
            ...source,
            id: row.subjectId,
            type: row.subject.type,
            labels: { en: row.subject.label.value },
            descriptions: {},
            aliases: {},
            statements: {},
            relationCounts: {},
          },
        };
      },
    },
  ];
  return {
    routes,
    entries,
    summary,
    labelAssignments,
    select(next: MemberShelfState | null) {
      state = next;
      titlePrepared = false;
    },
  };
}
export const memberShelfFixture = createMemberShelfFixture();
