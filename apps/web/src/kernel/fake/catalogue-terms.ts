import { createKernelClient, type SubjectRead } from '@rezics/client';
import { patchSubjectTerms, readSubjectTerms } from '../../features/catalogue/subject-terms-request';
import {
  patchedTerms,
  type TermsCommand,
  type TermsPageAuthority,
  type TermsPatch,
  type TermsTransport,
} from '../../features/catalogue/subject-terms';
import { candidateContext } from '../../subject/candidates';
import type { FakeRoute } from '../fake-modules';

export const termsSubjectId = '00000000-0000-4000-8000-00000000c003';
export type TermsScenario =
  | 'ready'
  | 'loading'
  | 'empty'
  | 'signed-out'
  | 'denied'
  | 'stale'
  | 'conflict'
  | 'invalid'
  | 'write-concealed'
  | 'uncertain'
  | 'saving'
  | 'concealed'
  | 'read-unavailable'
  | 'reader-denied'
  | 'action-unavailable'
  | 'action-denied';

/** Native-shaped samples only: this isolated request seam is not native execution proof. */
export function catalogueTermsFixture(scenario: TermsScenario = 'ready', locale = 'en') {
  let active = scenario;
  let lost = false;
  let patched = false;
  let reads = 0;
  let subject: SubjectRead['subject'] = {
    id: termsSubjectId,
    type: 'schema:Movie',
    revision: 7,
    release: 'fixture-release',
    context: candidateContext,
    labels: { en: 'Original film', ja: '元の映画' },
    descriptions: { en: 'Original description', ja: '元の説明' },
    aliases: { en: ['Working title'], ja: ['別名'] },
    resolution: {},
    relationCounts: {},
    statements: {},
    sourceRecords: [],
  };
  const receipts = new Map<string, { subject: string; revision: number }>();
  const calls: {
    method: string;
    path: string;
    body: unknown;
    key: string | null;
    etag: string | null;
    authorization: string | null;
    session: string | null;
  }[] = [];
  const json = (body: unknown, status = 200, revision = subject.revision) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        etag: `"${revision}"`,
        'rezics-session-token': patched ? 'terms-write' : 'terms-read',
      },
    });
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(request.url).pathname;
      const body: unknown = request.method === 'PATCH' ? await request.json() : null;
      const key = request.headers.get('idempotency-key');
      calls.push({
        method: request.method,
        path,
        body,
        key,
        etag: request.headers.get('if-match'),
        authorization: request.headers.get('authorization'),
        session: request.headers.get('rezics-session-token'),
      });
      if (request.method === 'GET' && path === `/v1/subjects/${termsSubjectId}`) {
        reads++;
        if (active === 'loading') return new Promise<Response>(() => {});
        if (active === 'concealed') return json({ code: 'not_found' }, 404);
        if (active === 'read-unavailable' && reads === 1) return json({ code: 'overloaded' }, 503);
        if (active === 'reader-denied' && patched) return json({ code: 'forbidden' }, 403);
        return json({ subject, account: null, summary: null, related: {} } satisfies SubjectRead);
      }
      if (request.method === 'PATCH' && path === `/v1/subjects/${termsSubjectId}/terms`) {
        if (active === 'saving') return new Promise<Response>(() => {});
        if (active === 'denied') return json({ code: 'forbidden' }, 403);
        if (active === 'write-concealed') return json({ code: 'not_found' }, 404);
        if (active === 'invalid') return json({ code: 'invalid_request' }, 422);
        if (active === 'conflict') return json({ code: 'idempotency_conflict' }, 422);
        if (active === 'stale') {
          active = 'ready';
          subject = { ...subject, revision: 8, labels: { ...subject.labels, en: 'Another editor’s title' } };
          return json({ code: 'precondition_failed' }, 412);
        }
        const retained = receipts.get(key!);
        if (retained) return json(retained, 200, retained.revision);
        subject = { ...subject, ...patchedTerms(subject, body as TermsPatch), revision: subject.revision + 1 };
        patched = true;
        const receipt = { subject: subject.id, revision: subject.revision };
        receipts.set(key!, receipt);
        if (active === 'uncertain' && !lost) {
          lost = true;
          throw new TypeError('Response lost');
        }
        return json(receipt);
      }
      return json({ code: 'not_found' }, 404);
    }) as typeof fetch,
  });
  const request = () =>
    new Request('https://site.invalid/api', { method: 'POST', headers: { authorization: 'Bearer fixture' } });
  const transport: TermsTransport = {
    read: (id, session) => readSubjectTerms(client, id, locale, 'Bearer fixture', session),
    readAuthority: async (): Promise<TermsPageAuthority> =>
      active === 'action-unavailable'
        ? { viewer: 'signed-in', actions: { state: 'unavailable' } }
        : active === 'action-denied'
          ? { viewer: 'signed-in', actions: { state: 'ready', actions: [] } }
          : active === 'signed-out'
            ? { viewer: 'signed-out', actions: { state: 'ready', actions: [] } }
            : {
                viewer: 'signed-in',
                actions: {
                  state: 'ready',
                  actions: [{ action: 'statement:propose', operations: ['subject.terms'] }],
                },
              },
    submit: (command: TermsCommand) => patchSubjectTerms(client, request(), {}, command, locale),
  };
  return {
    client,
    transport,
    calls,
    setScenario: (next: TermsScenario) => {
      active = next;
    },
    get subject() {
      return subject;
    },
  };
}

export const routes: FakeRoute[] = [];
