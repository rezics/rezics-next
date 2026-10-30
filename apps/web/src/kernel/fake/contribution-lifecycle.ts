import { createKernelClient } from '@rezics/client';
import { candidateFixture } from './subject-candidates';
import {
  changeContribution,
  readContributionAvailability,
  type ContributionCommand,
  type ContributionTransport,
} from '../../features/catalogue/contribution-lifecycle';

export type ContributionScenario =
  | 'ready'
  | 'denied'
  | 'expired'
  | 'invalid'
  | 'unavailable'
  | 'loading'
  | 'empty'
  | 'withheld'
  | 'uncertain';

/** Isolated declared-interface story/request seam. Never mounted in the development kernel fake. */
export function contributionFixture(scenario: ContributionScenario = 'ready', locale = 'en') {
  const base = candidateFixture('ready', locale);
  // This is a just-submitted native proposal in the story, not a provenance-based ownership decision.
  base.candidate.source = null;
  const calls: {
    method: string;
    path: string;
    authorization: string | null;
    session: string | null;
    key: string | null;
    body: unknown;
  }[] = [];
  const path = `/v1/subjects/${base.id}/candidates/${base.candidate.id}`;
  let deleted = false;
  let lost = false;
  const receipts = new Map<string, string>();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'contribution-session' },
    });
  const fetcher = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const key = request.headers.get('idempotency-key');
    calls.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get('authorization'),
      session: request.headers.get('rezics-session-token'),
      key,
      body: request.method === 'POST' ? await request.clone().json() : null,
    });
    if (url.pathname === path || url.pathname === `${path}:restoreDeleted`) {
      if (scenario === 'loading') return new Promise<Response>(() => {});
      if (!request.headers.has('authorization') || scenario === 'denied') return json({ code: 'forbidden' }, 403);
      if (scenario === 'invalid') return json({ code: 'invalid_request' }, 422);
      if (scenario === 'unavailable') return json({ code: 'not_found' }, 404);
      if (scenario === 'expired' && request.method === 'POST') return json({ code: 'conflict' }, 409);
      if (!key) return json({ code: 'invalid_request' }, 400);
      const operation = request.method === 'DELETE' ? 'delete' : 'restore';
      if (receipts.has(key) && receipts.get(key) !== operation) return json({ code: 'conflict' }, 409);
      if (!receipts.has(key)) {
        deleted = operation === 'delete';
        receipts.set(key, operation);
      }
      // The response schema is not published yet. Do not invent deadlines or grant fields in samples.
      if (scenario === 'uncertain' && !lost) {
        lost = true;
        throw new Error('Lost lifecycle response');
      }
      return json({});
    }
    if (request.method === 'GET' && url.pathname === `/v1/subjects/${base.id}/candidates`) {
      if (scenario === 'withheld' && !deleted) return json({ code: 'not_found' }, 404);
      if (deleted) return json({ candidates: [{ id: base.candidate.id, deleted: true }], adoption: null, next: null });
    }
    return base.fetcher(request);
  }) as typeof fetch;
  const client = createKernelClient('https://contribution.test', { fetch: fetcher });
  const address = { id: base.id, candidate: base.candidate.id, property: base.property, session: 'proposal-session' };
  const transport: ContributionTransport = {
    change: (command: ContributionCommand) => changeContribution(client, 'Bearer fixture', command),
    read: (address) => readContributionAvailability(client, 'Bearer fixture', address),
  };
  return { ...base, client, fetcher, calls, transport, address };
}
