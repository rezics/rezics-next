import entriesRecording from '../recorded/library-continue-entries.json';
import sessionsRecording from '../recorded/library-continue-progress-sessions.json';
import homePageRecording from '../recorded/home-page.json';
import definitionsRecording from '../recorded/definitions-release.json';
import { progressSessionProfile } from '../../library/progress-profile';
import type { ProgressMode } from '../../library/progress-reads';
import type { NativeContinuePage } from '../../library/continue-adapter';
import type { Release } from '../../subject/definitions';
import { recordedBookState } from './library-entry-states.ts';
import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';
import { chosenLabels, isRecord } from './languages.ts';

/**
 * Presentation for these pre-profile recordings, from the fixed vocabulary in their retained release.
 * This is not a native DTO or evidence of current write support. Never resolve it through the active head.
 */
export function recordedContinueSessions(locale: string) {
  return sessionsRecording.progressSessions.map((session) => {
    const mode = session.mode;
    if (mode !== 'scalar_amount' && mode !== 'cursor_position' && mode !== 'completed_units')
      throw new Error('Unrecognized recorded progress mode');
    return {
      ...session,
      mode: mode as ProgressMode,
      ...progressSessionProfile(definitionsRecording.release as unknown as Release, '', mode, session.unit, locale),
    };
  });
}

type ContinueHeader = {
  id: string;
  type: string;
  types?: string[];
  label: string | { value: string; language: string };
  cover?: unknown;
};

const homeRecording = homePageRecording as KernelRecording;
const homeRead = isRecord(homeRecording.reads) ? homeRecording.reads.r0 : undefined;
const homeBody = isRecord(homeRead) ? homeRead.body : undefined;
const homeLabels = new Map<string, Record<string, string>>(
  (isRecord(homeBody) && Array.isArray(homeBody.subjects) ? homeBody.subjects : []).flatMap((value) => {
    if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.labels)) return [];
    const labels = Object.fromEntries(
      Object.entries(value.labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    return [[value.id, labels] as const];
  }),
);

/** Replay the header language selected for the same embedded subject the Home catalogue displays. */
export function localizeContinueHeader(subject: ContinueHeader, request: Request): ContinueHeader {
  const labels = homeLabels.get(subject.id);
  if (!labels) return subject;
  const languages = (request.headers.get('accept-language') ?? '')
    .split(',')
    .map((value) => value.split(';', 1)[0]?.trim())
    .filter((language): language is string => Boolean(language));
  const original = typeof subject.label === 'object' ? subject.label.language : undefined;
  const selected = chosenLabels(labels, languages, original);
  const [language, value] = Object.entries(selected)[0] ?? [];
  return language && value ? { ...subject, label: { value, language } } : subject;
}

const entrylessId = '01a17ff1-0000-7000-8000-000000000001';
const entrylessSession = {
  ...sessionsRecording.progressSessions[0]!,
  id: '01a17ff1-0000-7000-8000-000000000002',
  subjectId: entrylessId,
  versionSubjectId: entrylessId,
};

let storySize = 6;
export function setContinueStorySize(size: number): void {
  storySize = Math.max(0, Math.min(6, Math.floor(size)));
}

function subjects(): Record<string, unknown>[] {
  const activeState = recordedBookState(1);
  const entries = entriesRecording.libraryEntries.filter((entry) => entry.state === activeState);
  const available: Record<string, unknown>[] = [
    ...entries.slice(0, 3).map((entry, index) => ({
      subjectId: entry.subjectId,
      state: index === 0 ? activeState : index === 1 ? 'not-a-state-id' : null,
      lastActivityAt: `2026-10-28T00:38:4${index}.000Z`,
      activeProgressSession: basicSession(
        sessionsRecording.progressSessions.find((item) => item.subjectId === entry.subjectId),
      ),
    })),
    {
      subjectId: entrylessId,
      state: null,
      lastActivityAt: '2026-10-28T00:38:49.000Z',
      activeProgressSession: basicSession(entrylessSession),
    },
  ];
  while (available.length < 6) {
    const index = available.length;
    const subjectId = `01a17ff1-0000-7000-8000-${String(index + 1).padStart(12, '0')}`;
    available.push({
      subjectId,
      state: index % 2 === 0 ? activeState : null,
      lastActivityAt: `2026-10-28T00:39:${String(index).padStart(2, '0')}.000Z`,
      activeProgressSession: {
        ...basicSession(entrylessSession),
        id: subjectId,
        subjectId,
        versionSubjectId: subjectId,
      },
    });
  }
  return available.slice(0, storySize);
}

function basicSession<Session extends { subject: unknown }>(session: Session | undefined) {
  if (!session) return null;
  const { subject: _subject, ...basic } = session;
  return basic;
}

type NativeSummary = NonNullable<NativeContinuePage['subjects'][number]['subject']>;
// These retained summaries are presentation inputs, not recordings of native Continue responses.
// Key by the supplied summary ID: an entry's stored reference cannot rename its header.
const summaries = new Map<string, NativeSummary>(
  [...entriesRecording.libraryEntries, ...sessionsRecording.progressSessions].flatMap((row) =>
    row.subject ? [[row.subject.id, row.subject] as const] : [],
  ),
);

function continueResponse(request: Request): KernelRecording {
  const headers = { 'cache-control': 'private, no-store' };
  const problem = (status: number, code: string): KernelRecording => ({ status, code, headers });
  const query = new URL(request.url).searchParams;
  for (const key of query.keys())
    if (!['limit', 'cursor', 'view', 'spaceId'].includes(key) || query.getAll(key).length !== 1)
      return problem(400, 'invalid_request');
  const view = query.get('view') ?? 'BASIC';
  const rawLimit = query.get('limit');
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (
    (view !== 'BASIC' && view !== 'FULL') ||
    rawLimit?.trim() === '' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    return problem(400, 'invalid_request');
  const spaceId = query.get('spaceId');
  if (spaceId !== null && !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(spaceId))
    return problem(400, 'invalid_request');
  // No native Space population or signed continuation recording is supplied by this fixture.
  if (query.has('cursor')) return problem(400, 'invalid_cursor');
  if (unavailable(request)) return problem(503, 'service_unavailable');
  const rows = subjects();
  if (spaceId !== null || rows.length > limit) return problem(503, 'dependency_unavailable');
  return {
    status: 200,
    subjects:
      view === 'BASIC' ? rows : rows.map((row) => ({ ...row, subject: summaries.get(String(row.subjectId)) ?? null })),
    next: null,
    headers,
  };
}

const headers = new Map<string, ContinueHeader>([
  ...entriesRecording.libraryEntries.flatMap((entry) =>
    entry.subject ? [[entry.subjectId, entry.subject] as const] : [],
  ),
  [
    entrylessId,
    {
      id: entrylessId,
      type: 'schema:Book',
      types: ['schema:Book', 'schema:CreativeWork'],
      label: { value: 'Entry-less session', language: 'en' },
      cover: null,
    },
  ],
]);

async function body(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request
    .clone()
    .json()
    .catch(() => undefined);
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function unavailable(request: Request): boolean {
  return request.headers.get('authorization') === 'Bearer fake-continue-503';
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/libraryContinue',
    story: ({ request }) => continueResponse(request),
    fixture: ({ request }) => continueResponse(request),
  },
  {
    method: 'POST',
    path: '/v1/pages:read',
    story: async ({ request }) => {
      const input = await body(request);
      if (typeof input.reads !== 'object' || input.reads === null) return;
      const descriptors = input.reads as Record<string, { kind?: string; id?: string }>;
      const reads: Record<string, unknown> = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        const header =
          descriptor.kind === 'subject' && descriptor.id
            ? (headers.get(descriptor.id) ?? syntheticHeader(descriptor.id))
            : undefined;
        const subject = header ? localizeContinueHeader(header, request) : undefined;
        reads[key] = subject
          ? { status: 200, body: { subject } }
          : { status: 404, body: { code: 'subject_not_found' } };
      }
      return { status: 200, reads } as KernelRecording;
    },
    fixture: async ({ request }) => {
      const input = await body(request);
      if (typeof input.reads !== 'object' || input.reads === null) return;
      const descriptors = input.reads as Record<string, { kind?: string; id?: string }>;
      const reads: Record<string, unknown> = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        const header =
          descriptor.kind === 'subject' && descriptor.id
            ? (headers.get(descriptor.id) ?? syntheticHeader(descriptor.id))
            : undefined;
        const subject = header ? localizeContinueHeader(header, request) : undefined;
        reads[key] = subject
          ? { status: 200, body: { subject } }
          : { status: 404, body: { code: 'subject_not_found' } };
      }
      return { status: 200, reads } as KernelRecording;
    },
  },
];

function syntheticHeader(id: string): ContinueHeader | undefined {
  return id.startsWith('01a17ff1-0000-7000-8000-')
    ? {
        id,
        type: 'schema:Book',
        types: ['schema:Book', 'schema:CreativeWork'],
        label: { value: `Continue title ${id.slice(-2)}`, language: 'en' },
        cover: null,
      }
    : undefined;
}
