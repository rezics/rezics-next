import type { Related, Subject } from '../subject/types';
type Fixtures = {
  subjects: Subject[];
  properties: { id: string; labels: Record<string, string> }[];
  redirects: Record<string, string>;
};

export type KernelRecording = { status: number; [key: string]: unknown };

const missingSubjectId = '00000000-0000-4000-8000-000000000000';

function resourceId(recording: KernelRecording | undefined, key: string): string | undefined {
  const value = recording?.[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
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

export function createFakeKernelFetch(fixtures: Fixtures): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const match = /^\/v1\/subjects\/([^/]+)$/.exec(url.pathname);
    const notFound = () =>
      Response.json(
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
    if (request.method !== 'GET' || !match) return notFound();
    const id = decodeURIComponent(match[1]!);
    const target = fixtures.redirects[id] ?? id;
    const subject = fixtures.subjects.find((item) => item.id === target);
    if (!subject) return notFound();
    const related: Related = {};
    const labelSubject = (subjectId: string) => {
      const redirect = fixtures.redirects[subjectId];
      const item = fixtures.subjects.find((candidate) => candidate.id === (redirect ?? subjectId));
      if (item) related[subjectId] = { labels: item.labels, ...(redirect ? { redirect } : {}) };
    };
    const visit = (snak: {
      property: { id: string; data_type: string };
      value: { type: string; content?: unknown };
    }) => {
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
    return Response.json({ subject, related });
  }) as typeof fetch;
}
