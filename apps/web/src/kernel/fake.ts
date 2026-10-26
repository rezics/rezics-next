import {
  planReads,
  platformRegistry,
  profileDigest,
  resolveTemplate,
  type PageRead,
  type PresentationProfile,
} from '@rezics/composition';
import platformProfileJson from '@rezics/composition/profiles/platform.json' with { type: 'json' };
import type { Related, Subject } from '../subject/types';
import homePageRecording from './recorded/home-page.json';
import missingSubjectPageRecording from './recorded/missing-subject-page.json';
import missingSubjectRecording from './recorded/missing-subject.json';
import subjectPageRecording from './recorded/subject-page.json';
import subjectRecording from './recorded/subject.json';
import boardRecording from './recorded/board.json';
import boardThreadsRecording from './recorded/board-threads.json';
import threadRecording from './recorded/thread.json';
import threadPostsRecording from './recorded/thread-posts.json';
import searchRecording from './recorded/search.json';
import searchEmptyRecording from './recorded/search-empty.json';

const platformProfile = platformProfileJson as PresentationProfile;
const platformDigest = profileDigest(platformProfile);

type Fixtures = {
  subjects: Subject[];
  properties: { id: string; labels: Record<string, string> }[];
  redirects: Record<string, string>;
  /** Structural bases by type, copied from the bundled definitions release. */
  types: Record<string, { bases: string[] }>;
};

export type KernelRecording = { status: number; [key: string]: unknown };

const missingSubjectId = '00000000-0000-4000-8000-000000000000';

function resourceId(recording: KernelRecording | undefined, key: string): string | undefined {
  const value = recording?.[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function knownSubjectId(recordings: Record<string, KernelRecording>): string | undefined {
  const subject = recordings['subject-page']?.subject;
  return typeof subject === 'string' ? subject : resourceId(recordings.subject, 'subject');
}

/** `POST /v1/pages:read` for the recorded subject, or the fixed missing id. */
async function pageRecording(
  request: Request,
  recordings: Record<string, KernelRecording>,
): Promise<KernelRecording | undefined> {
  let subject: unknown;
  let route: unknown;
  try {
    const body = (await request.json()) as { target?: unknown };
    const target = body.target;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
    subject = (target as { subject?: unknown }).subject;
    route = (target as { route?: unknown }).route;
  } catch {
    return undefined;
  }
  if (typeof route === 'string') return route === '/' ? recordings['home-page'] : undefined;
  if (typeof subject !== 'string') return undefined;
  if (subject === missingSubjectId) return recordings['missing-subject-page'];
  return subject === knownSubjectId(recordings) ? recordings['subject-page'] : undefined;
}

function recordedResponse(recording: KernelRecording): Response {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(recording)) {
    if (key === 'status' || key === 'query') continue;
    body[key] = value;
  }
  return Response.json(body, {
    status: recording.status,
    headers: { 'content-type': recording.status === 404 ? 'application/problem+json' : 'application/json' },
  });
}

async function selectRecording(
  request: Request,
  pathname: string,
  recordings: Record<string, KernelRecording>,
): Promise<KernelRecording | undefined> {
  if (request.method === 'GET') {
    const subject = /^\/v1\/subjects\/([^/]+)$/.exec(pathname);
    if (subject?.[1]) {
      const id = decodeURIComponent(subject[1]);
      return recordings[id === missingSubjectId ? 'missing-subject' : 'subject'];
    }
    const boardThreads = /^\/v1\/boards\/([^/]+)\/threads$/.exec(pathname);
    if (boardThreads?.[1] && decodeURIComponent(boardThreads[1]) === resourceId(recordings.board, 'board'))
      return recordings['board-threads'];
    const board = /^\/v1\/boards\/([^/]+)$/.exec(pathname);
    if (board?.[1] && decodeURIComponent(board[1]) === resourceId(recordings.board, 'board')) return recordings.board;
    const posts = /^\/v1\/threads\/([^/]+)\/posts$/.exec(pathname);
    if (posts?.[1] && decodeURIComponent(posts[1]) === resourceId(recordings.thread, 'thread'))
      return recordings['thread-posts'];
    const thread = /^\/v1\/threads\/([^/]+)$/.exec(pathname);
    if (thread?.[1] && decodeURIComponent(thread[1]) === resourceId(recordings.thread, 'thread'))
      return recordings.thread;
    return undefined;
  }
  if (request.method === 'POST' && pathname === '/v1/pages:read') return pageRecording(request, recordings);
  if (request.method !== 'POST' || pathname !== '/v1/subjects:search') return undefined;
  let text: unknown;
  try {
    text = ((await request.json()) as { text?: unknown }).text;
  } catch {
    return undefined;
  }
  if (typeof text !== 'string') return undefined;
  return Object.values(recordings).find((recording) => recording.query === text);
}

/** Replay committed API bodies through the same fetch boundary used by fixture-backed tests. */
export function createRecordedKernelFetch(recordings: Record<string, KernelRecording>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const recording = await selectRecording(request, new URL(request.url).pathname, recordings);
    if (!recording) return new Response(null, { status: 404 });
    return recordedResponse(recording);
  }) as typeof fetch;
}

/** The browser-only Storybook kernel uses the checked-in responses for the real page routes. */
export function createStoryRecordedKernelFetch(): typeof fetch {
  return createRecordedKernelFetch({
    'home-page': homePageRecording,
    'missing-subject-page': missingSubjectPageRecording,
    'missing-subject': missingSubjectRecording,
    'subject-page': subjectPageRecording,
    subject: subjectRecording,
    board: boardRecording,
    'board-threads': boardThreadsRecording,
    thread: threadRecording,
    'thread-posts': threadPostsRecording,
    search: searchRecording,
    'search-empty': searchEmptyRecording,
  });
}

function notFound(): Response {
  return Response.json(
    {
      type: 'https://rezics.com/problems/not_found',
      title: 'Not Found',
      status: 404,
      code: 'not_found',
      retryable: false,
      effect_status: 'not_applicable',
      request_id: crypto.randomUUID(),
    },
    { status: 404, headers: { 'content-type': 'application/problem+json' } },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The same subject payload `GET /v1/subjects/:id` returns, including a merged subject's survivor. */
function subjectPayload(fixtures: Fixtures, id: string): { subject: Subject; related: Related } | undefined {
  const target = fixtures.redirects[id] ?? id;
  const subject = fixtures.subjects.find((item) => item.id === target);
  if (!subject) return undefined;
  const related: Related = {};
  const labelSubject = (subjectId: string) => {
    const redirect = fixtures.redirects[subjectId];
    const item = fixtures.subjects.find((candidate) => candidate.id === (redirect ?? subjectId));
    if (item) related[subjectId] = { labels: item.labels, ...(redirect ? { redirect } : {}) };
  };
  const visit = (snak: { property: { id: string; data_type: string }; value: { type: string; content?: unknown } }) => {
    const property = fixtures.properties.find((item) => item.id === snak.property.id);
    if (property) related[property.id] = { labels: property.labels };
    if (
      snak.property.data_type === 'wikibase-item' &&
      snak.value.type === 'value' &&
      typeof snak.value.content === 'string'
    )
      labelSubject(snak.value.content);
  };
  for (const statements of Object.values(subject.statements))
    for (const statement of statements) {
      visit(statement);
      statement.qualifiers.forEach(visit);
      statement.references.flatMap((reference) => reference.parts).forEach(visit);
    }
  return { subject, related };
}

function byEnglishLabel(left: Subject, right: Subject): number {
  const leftLabel = left.labels.en ?? '';
  const rightLabel = right.labels.en ?? '';
  if (leftLabel < rightLabel) return -1;
  if (leftLabel > rightLabel) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

/** Subjects with a statement of that property naming one of the filter's subjects. */
function searchRead(fixtures: Fixtures, read: Extract<PageRead, { kind: 'search' }>) {
  const filter = read.body.filter;
  if ('type' in filter) {
    const types = new Set(filter.type.in);
    const matched = fixtures.subjects.filter((subject) => types.has(subject.type)).sort(byEnglishLabel);
    const subjects = matched.slice(0, read.body.limit).map(({ id, type, labels }) => ({ id, type, labels }));
    return {
      subjects,
      total: { value: matched.length, relation: 'exact' as const },
      next: null,
      as_of: '2026-10-26T00:00:00.000Z',
    };
  }
  const named = 'statement' in filter ? filter.statement : undefined;
  const ids = new Set(named?.in ?? []);
  const matched = named
    ? fixtures.subjects.filter((subject) =>
        subject.statements[named.property]?.some(
          (statement) =>
            statement.value.type === 'value' &&
            typeof statement.value.content === 'string' &&
            ids.has(statement.value.content),
        ),
      )
    : [];
  matched.sort(byEnglishLabel);
  const subjects = matched.slice(0, read.body.limit).map(({ id, type, labels }) => ({ id, type, labels }));
  return {
    subjects,
    total: { value: matched.length, relation: 'exact' as const },
    next: null,
    as_of: '2026-10-26T00:00:00.000Z',
  };
}

async function pageRead(fixtures: Fixtures, request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return notFound();
  }
  const target = isRecord(body) ? body.target : undefined;
  const requested = isRecord(target) && typeof target.subject === 'string' ? target.subject : undefined;
  const requestedRoute = isRecord(target) && typeof target.route === 'string' ? target.route : undefined;
  if (!requested && requestedRoute === undefined) return notFound();
  const payload = requested ? subjectPayload(fixtures, requested) : undefined;
  if (requested && !payload) return notFound();
  const definition = payload ? fixtures.types[payload.subject.type] : undefined;
  const resolved = resolveTemplate(
    platformProfile,
    requestedRoute !== undefined
      ? { route: requestedRoute }
      : {
          type: payload!.subject.type,
          ...(definition ? { bases: definition.bases } : {}),
        },
  );
  const plan = planReads(platformRegistry, resolved.document, { subject: payload?.subject.id ?? null });
  const reads: Record<string, { status: number; body: unknown }> = {};
  for (const [key, descriptor] of Object.entries(plan.reads)) {
    // The subject read that selected the template is reused.
    reads[key] =
      descriptor.kind === 'subject' && descriptor.id === payload?.subject.id && payload
        ? { status: 200, body: payload }
        : descriptor.kind === 'search'
          ? { status: 200, body: searchRead(fixtures, descriptor) }
          : { status: 404, body: { code: 'not_found' } };
  }
  return Response.json({
    ...(payload ? { subject: payload.subject.id } : {}),
    profile: platformDigest,
    template: { scope: resolved.scope, key: resolved.key },
    document: resolved.document,
    reads,
  });
}

export function createFakeKernelFetch(fixtures: Fixtures): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/v1/pages:read') return pageRead(fixtures, request);
    const match = /^\/v1\/subjects\/([^/]+)$/.exec(url.pathname);
    if (request.method !== 'GET' || !match) return notFound();
    const payload = subjectPayload(fixtures, decodeURIComponent(match[1]!));
    return payload ? Response.json(payload) : notFound();
  }) as typeof fetch;
}
