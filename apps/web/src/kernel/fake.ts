import type { Related, Subject } from '../subject/types';
type Fixtures = {
  subjects: Subject[];
  properties: { id: string; labels: Record<string, string> }[];
  redirects: Record<string, string>;
};

export type KernelRecording = { status: number; [key: string]: unknown };

/** Replay committed API bodies through the same fetch boundary used by fixture-backed tests. */
export function createRecordedKernelFetch(recordings: Record<string, KernelRecording>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const match = /^\/v1\/subjects\/([^/]+)$/.exec(url.pathname);
    const id = match ? decodeURIComponent(match[1]!) : undefined;
    const name = id === '00000000-0000-4000-8000-000000000000' ? 'missing-subject' : id ? 'subject' : undefined;
    const recording = request.method === 'GET' && name ? recordings[name] : undefined;
    if (!recording) return new Response(null, { status: 404 });
    return Response.json(recording, {
      status: recording.status,
      headers: { 'content-type': recording.status === 404 ? 'application/problem+json' : 'application/json' },
    });
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
