import { createKernelClient, type SubjectRead } from '@rezics/client';
import { candidateContext, type Candidate } from '../../subject/candidates';
import {
  readStatementConsent,
  changeStatementConsent,
  readConsentPublic,
  type ConsentAddress,
  type ConsentCommand,
  type ConsentTransport,
} from '../../features/catalogue/statement-consent';
import type { FakeRoute } from '../fake-modules';
import recording from '../recorded/subject.json';
import definitions from '../recorded/definitions-release.json';

export type ConsentScenario =
  | 'private'
  | 'identity-withheld'
  | 'subject-unlabelled'
  | 'read-denied'
  | 'public'
  | 'sourced'
  | 'empty'
  | 'more'
  | 'denied'
  | 'missing'
  | 'invalid'
  | 'conflict'
  | 'unavailable'
  | 'pending'
  | 'read-unavailable'
  | 'actions-unavailable'
  | 'actions-refused'
  | 'deleted'
  | 'lagging-deletion'
  | 'retracted'
  | 'lost-response'
  | 'lagging-retraction';

/** Declared samples for stories/focused request tests only; never a successful runtime mutation handler. */
export function consentFixture(scenario: ConsentScenario = 'private') {
  const subject = structuredClone(recording) as unknown as SubjectRead;
  const id = subject.subject.id;
  const candidateId = `${id.slice(0, -3)}881`;
  const target = `${id.slice(0, -3)}882`;
  const property = 'rezics:penNameOf';
  const address: ConsentAddress = { id, property, candidate: candidateId, slot: { target } };
  subject.subject.context = candidateContext;
  subject.subject.type = 'schema:Person';
  subject.subject.labels = scenario === 'subject-unlabelled' ? {} : { en: 'River Ink' };
  subject.subject.statements = {};
  subject.subject.release = definitions.digest;
  subject.related = {};
  const candidate: Candidate = {
    id: candidateId,
    release: definitions.digest,
    revision: 2,
    source: null,
    retracted: null,
    retraction: null,
    decision: 'accepted',
    head: 1,
    rank: 'normal',
    consentIdentity: {
      subject: { id, labels: subject.subject.labels },
      target: scenario === 'identity-withheld' ? null : { id: target, labels: { en: 'The person behind the name' } },
    },
    statement: {
      id: candidateId,
      rank: 'normal',
      property: { id: property, data_type: 'wikibase-item' },
      value: { type: 'value', content: target },
      qualifiers: [],
      references: [],
      rezics: { release: definitions.digest, revision: 2 },
    },
  };
  if (scenario === 'sourced')
    candidate.statement.references = [
      {
        hash: 'citation',
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value', content: 'https://example.org/interview' },
          },
        ],
      },
    ];
  let disclosed = scenario === 'public' || scenario === 'lagging-retraction' || scenario === 'lagging-deletion';
  let retracted = scenario === 'retracted';
  let lost = false;
  const calls: {
    path: string;
    method: string;
    authorization: string | null;
    /** Decoded native command key, alongside its exact structured-field wire value. */
    key: string | null;
    keyHeader: string | null;
    session: string | null;
    body: string;
    cache: string;
  }[] = [];
  const receipts = new Map<string, { candidate: string; disclosed: true } | { candidate: string; retracted: true }>();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'rezics-session-token': 'consent-session',
        'cache-control': 'private, no-store',
      },
    });
  const fetcher = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const path = url.pathname;
    const authorization = request.headers.get('authorization');
    const keyHeader = request.headers.get('idempotency-key');
    let key: string | null = null;
    if (keyHeader !== null) {
      try {
        const value: unknown = JSON.parse(keyHeader);
        if (typeof value === 'string') key = value;
      } catch {
        // Native commands require a structured-field string, rather than an unquoted token.
      }
    }
    calls.push({
      path,
      method: request.method,
      authorization,
      key,
      keyHeader,
      session: request.headers.get('rezics-session-token'),
      body: await request.clone().text(),
      cache: request.cache,
    });
    if (path === `/v1/subjects/${id}` && request.method === 'GET') {
      if (scenario === 'read-unavailable') return json({ code: 'semantic_not_ready' }, 503);
      const current = structuredClone(subject);
      if (disclosed && (!retracted || scenario === 'lagging-retraction') && scenario !== 'pending')
        current.subject.statements[property] = [structuredClone(candidate.statement)];
      return json(current);
    }
    if (path === `/v1/definitions/releases/${encodeURIComponent(definitions.digest)}`) return json(definitions);
    if (path === `/v1/statements/${candidateId}/consent` && request.method === 'GET') {
      if (scenario === 'actions-unavailable') return json({ code: 'dependency_unavailable' }, 503);
      if (scenario === 'actions-refused' || authorization !== 'Bearer target-owner') return json({ state: 'refused' });
      if (retracted) return json({ state: 'terminal' });
      return json({
        state: 'available',
        disclosed,
        operations: [...(!disclosed ? ['statement.disclose'] : []), 'statement.retract'],
      });
    }
    if (path === `/v1/subjects/${id}/candidates`) {
      if (scenario === 'read-denied') return json({ code: 'forbidden' }, 403);
      if (scenario === 'empty') return json({ candidates: [], adoption: null, next: null });
      if (scenario === 'more' && !url.searchParams.has('cursor'))
        return json({ candidates: [], adoption: null, next: 'next-page' });
      if (scenario === 'missing') return json({ code: 'not_found' }, 404);
      if (!authorization) return json({ code: 'invalid_credentials' }, 401);
      if (authorization !== 'Bearer target-owner') return json({ candidates: [], adoption: null, next: null });
      if (scenario === 'deleted' || scenario === 'lagging-deletion')
        return json({ candidates: [{ id: candidateId, deleted: true }], adoption: null, next: null });
      return json({
        candidates: [
          { ...candidate, ...(retracted ? { consentIdentity: undefined } : {}), retracted: retracted ? 3 : null },
        ],
        adoption: { mode: 'replace', head: 1 },
        next: null,
      });
    }
    if (
      request.method === 'POST' &&
      (path === `/v1/statements/${candidateId}/disclose` || path === `/v1/statements/${candidateId}/retract`)
    ) {
      if (authorization !== 'Bearer target-owner') return json({ code: 'forbidden' }, 403);
      if (!key) return json({ code: 'invalid_request' }, 400);
      if (scenario === 'deleted' || scenario === 'lagging-deletion') return json({ code: 'not_found' }, 404);
      const failure = { denied: 403, missing: 404, invalid: 400, conflict: 409, unavailable: 503 }[
        scenario as 'denied'
      ];
      if (failure) return json({ code: 'native_failure' }, failure);
      // Receipted replay still follows current authorization, matching the native contract.
      const receipt = `${path}:${key}`;
      if (receipts.has(receipt)) return json(receipts.get(receipt));
      if (candidate.statement.references.length) return json({ code: 'not_found' }, 404);
      if (path.endsWith('/disclose')) {
        if (retracted) return json({ code: 'conflict' }, 409);
        disclosed = true;
      } else retracted = true;
      const response = path.endsWith('/disclose')
        ? { candidate: candidateId, disclosed: true as const }
        : { candidate: candidateId, retracted: true as const };
      receipts.set(receipt, response);
      if (scenario === 'lost-response' && !lost) {
        lost = true;
        throw new Error('Response lost after native commit');
      }
      return json(response);
    }
    return json({ code: 'not_found' }, 404);
  }) as typeof fetch;
  const client = createKernelClient('https://consent.test', { fetch: fetcher });
  const transport: ConsentTransport = {
    read: (cursor, session) => readStatementConsent(client, 'Bearer target-owner', address, cursor, session),
    change: (command: ConsentCommand) => changeStatementConsent(client, 'Bearer target-owner', command),
    public: (session, terminal) => readConsentPublic(client, address, session, terminal),
  };
  return { address, candidate, client, calls, transport };
}

// Until actual native evidence is configured in development, these ports remain truthfully unserved.
export const routes: FakeRoute[] = [
  ...['disclose', 'retract'].map((operation) => ({
    method: 'POST',
    path: new RegExp(`^/v1/statements/[^/]+/${operation}$`),
    fixture: () => ({ status: 503, body: { code: 'partition_unavailable' } }),
    story: () => ({ status: 503, body: { code: 'partition_unavailable' } }),
  })),
  {
    method: 'GET',
    path: /^\/v1\/statements\/[^/]+\/consent$/,
    fixture: () => ({ status: 503, body: { code: 'partition_unavailable' } }),
    story: () => ({ status: 503, body: { code: 'partition_unavailable' } }),
  },
];
