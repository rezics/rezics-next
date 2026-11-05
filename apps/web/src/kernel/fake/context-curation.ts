import { createKernelClient, type SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { candidateFixture, fixtureCandidateViewerActions } from './subject-candidates';
import definitions from '../recorded/definitions-release.json';
import type { CandidateCommand, CandidatePage, ReviewContext } from '../../subject/candidates';
import { readContextCuration, confirmContextCuration } from '../../features/catalogue/context-curation';
import type { CandidateTransport } from '../../subject/candidate-review';
import type { FakeRoute } from '../fake-modules';

export type ContextScenario =
  | 'inherited'
  | 'replaced'
  | 'suppressed'
  | 'unresolved'
  | 'empty'
  | 'concealed'
  | 'loading'
  | 'denied'
  | 'adopt-denied'
  | 'conflict'
  | 'invalid'
  | 'unavailable'
  | 'uncertain';

/** Isolated native-shaped story/request seam; never installed as a successful runtime port. */
export function contextFixture(scenario: ContextScenario = 'inherited', locale = 'en') {
  const base = candidateFixture();
  const context: ReviewContext = {
    id: '00000000-0000-8000-8000-000000000321',
    kind: 'community',
    labels: {
      en: 'Readers’ edition',
      'zh-Hans': '读者版',
      'zh-Hant': '讀者版',
      ja: '読者版',
      ko: '독자판',
      de: 'Leserausgabe',
      fr: 'Édition des lecteurs',
      es: 'Edición de lectores',
    },
    settings: null,
    defaults: {},
  };
  const candidate = structuredClone(base.candidate);
  candidate.decision = scenario === 'unresolved' ? 'rejected' : 'accepted';
  candidate.head = 4;
  const reading = structuredClone(base.publicRead) as SubjectRead;
  reading.subject.context = context.id;
  let adoption: CandidatePage['adoption'] =
    scenario === 'replaced'
      ? { mode: 'replace', head: 7 }
      : scenario === 'suppressed'
        ? { mode: 'suppress', head: 7 }
        : { mode: 'inherit', head: 7 };
  if (scenario === 'replaced') {
    reading.subject.statements[base.property] = [candidate.statement];
    candidate.rank = 'normal';
  }
  if (scenario === 'suppressed' || scenario === 'unresolved' || scenario === 'empty') {
    reading.subject.statements[base.property] = [];
    if (scenario !== 'empty')
      reading.subject.resolution[base.property] = scenario === 'suppressed' ? 'suppressed' : 'unresolved';
  }
  const calls: {
    path: string;
    query: string;
    method: string;
    body: Record<string, unknown> | null;
    headers: Headers;
  }[] = [];
  let conflict = scenario === 'conflict';
  let uncertain = scenario === 'uncertain';
  const receipts = new Map<string, unknown>();
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
        'rezics-session-token': 'context-session',
      },
    });
  const fetcher = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const body = request.method === 'POST' ? ((await request.clone().json()) as Record<string, unknown>) : null;
    calls.push({ path: url.pathname, query: url.search, method: request.method, body, headers: request.headers });
    if (request.method === 'POST' && url.pathname === '/v1/viewerActions') {
      const resources = body?.resources as { type: string; id: string }[];
      const authority = fixtureCandidateViewerActions(scenario === 'adopt-denied' ? 'actions-denied' : 'ready');
      return json({
        resources: resources.map((resource) => {
          const component = resource.type === 'semantic.context' ? authority.context : authority.subject;
          return { ...resource, viewerActions: component.state === 'available' ? component.actions : [] };
        }),
      });
    }
    if (request.method === 'GET' && url.pathname === `/v1/contexts/${context.id}`) {
      if (scenario === 'loading') return new Promise<Response>(() => {});
      return scenario === 'unavailable' ? json({ code: 'overloaded' }, 503) : json({ context });
    }
    if (request.method === 'POST' && url.pathname === '/v1/viewerActions') {
      const references = body?.resources as { type: string; id: string }[] | undefined;
      return json({
        resources: (references ?? []).map(({ type, id }) =>
          type === 'semantic.context' && id === context.id
            ? {
                type,
                id,
                viewerActions: [
                  { action: 'context:accept', operations: ['subject.accept_candidate', 'subject.reject_candidate'] },
                  { action: 'context:adopt', operations: ['subject.adopt'] },
                ],
              }
            : type === 'semantic.subject' && id === base.id
              ? { type, id, viewerActions: [] }
              : { type, id, error: 'not_found' },
        ),
      });
    }
    if (
      request.method === 'GET' &&
      url.pathname === `/v1/subjects/${base.id}` &&
      url.searchParams.get('context') === context.id
    )
      return json(reading);
    if (request.method === 'GET' && url.pathname === `/v1/subjects/${base.id}/candidates`)
      return json({
        candidates:
          scenario === 'empty'
            ? []
            : scenario === 'concealed'
              ? [{ id: candidate.id, deleted: true } as unknown as CandidatePage['candidates'][number]]
              : [candidate],
        adoption,
        next: null,
      } satisfies CandidatePage);
    if (request.method === 'POST') {
      if (scenario === 'denied' || (scenario === 'adopt-denied' && url.pathname.endsWith(':adopt')))
        return json({ code: 'forbidden' }, 403);
      if (scenario === 'invalid') return json({ code: 'invalid_request' }, 400);
      if (conflict) {
        conflict = false;
        adoption = { mode: 'inherit', head: 8 };
        return json({ code: 'stale_editorial_head' }, 409);
      }
      const key = request.headers.get('idempotency-key')!;
      if (receipts.has(key)) return json(receipts.get(key));
      if (url.pathname.endsWith(':adopt')) {
        if (body?.expected_head !== adoption?.head) return json({ code: 'stale_editorial_head' }, 409);
        const selection = body?.selection as { candidate: string; rank: 'normal' | 'preferred' }[];
        if (
          (body?.mode !== 'replace' && selection.length) ||
          selection.some((entry) => entry.candidate !== candidate.id || candidate.decision !== 'accepted')
        )
          return json({ code: 'invalid_request' }, 400);
        const mode = body!.mode as 'inherit' | 'replace' | 'suppress';
        adoption = { mode, head: (adoption?.head ?? 0) + 1 };
        reading.subject.resolution = mode === 'suppress' ? { [base.property]: 'suppressed' } : {};
        reading.subject.statements[base.property] =
          mode === 'replace'
            ? selection.map((entry) => ({ ...candidate.statement, rank: entry.rank }))
            : mode === 'suppress'
              ? []
              : structuredClone(base.publicRead.subject.statements[base.property] ?? []);
        candidate.rank = mode === 'replace' ? (selection[0]?.rank ?? null) : null;
        const result = {
          adoption: { context: context.id, property: base.property, ...adoption, selection },
          revision: 5,
        };
        receipts.set(key, result);
        if (uncertain) {
          uncertain = false;
          return json({ code: 'overloaded' }, 503);
        }
        return json(result);
      }
      if (body?.expected_head !== candidate.head) return json({ code: 'stale_editorial_head' }, 409);
      candidate.decision = url.pathname.endsWith(':reject') ? 'rejected' : 'accepted';
      candidate.head = (candidate.head ?? 0) + 1;
      const result = {
        acceptance: {
          context: context.id,
          candidate: candidate.id,
          decision: candidate.decision === 'accepted' ? 'accept' : 'reject',
          head: candidate.head,
        },
        revision: 4,
      };
      receipts.set(key, result);
      return json(result);
    }
    return base.fetcher(request);
  }) as typeof fetch;
  const client = createKernelClient('https://context.test', { fetch: fetcher });
  const release = definitions.release as unknown as Release;
  const address = { id: base.id, context: context.id, property: base.property };
  const transport: CandidateTransport = {
    reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
    read: async (property, cursor, session) => {
      const result = await readContextCuration(
        client,
        'Bearer fixture',
        {
          id: address.id,
          context: address.context,
          ...(property ? { property } : {}),
          ...(cursor ? { cursor } : {}),
          ...(session ? { session } : {}),
        },
        release,
        locale,
      );
      return result.ok ? { ...result, actions: fixtureCandidateViewerActions() } : result;
    },
    confirm: (command: CandidateCommand) =>
      confirmContextCuration(client, 'Bearer fixture', { ...command, context: context.id }, release, locale),
  };
  return { ...base, context, candidate, reading, address, calls, client, release, transport };
}

export const routes: FakeRoute[] = [];
