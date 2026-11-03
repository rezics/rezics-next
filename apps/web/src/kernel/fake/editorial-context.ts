import { createKernelClient } from '@rezics/client';
import { contextFixture } from './context-curation';
import { candidateContext } from '../../subject/candidates';
import {
  readEditorialContext,
  submitEditorialContext,
  type EditorialTransport,
} from '../../features/catalogue/editorial-context';

export type EditorialScenario =
  | 'ready'
  | 'create'
  | 'global'
  | 'loading'
  | 'missing'
  | 'unavailable'
  | 'denied'
  | 'invalid'
  | 'conflict'
  | 'uncertain'
  | 'expired';

/** Native-shaped samples exclusively for stories and focused requests; never a successful runtime port. */
export function editorialContextFixture(scenario: EditorialScenario = 'ready', locale = 'en') {
  const review = contextFixture('inherited', locale);
  let context = structuredClone(review.context);
  if (scenario === 'global') context = { ...context, id: candidateContext, kind: 'global' };
  let deleted = false;
  let readUnavailable = scenario === 'unavailable';
  let uncertain = scenario === 'uncertain';
  let refusal: number | undefined =
    scenario === 'denied' ? 403 : scenario === 'invalid' ? 400 : scenario === 'conflict' ? 422 : undefined;
  const calls: { path: string; method: string; headers: Headers; body: unknown }[] = [];
  const receipts = new Map<string, unknown>();
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'editorial-session' },
    });
  const fetcher = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    const body = await request.clone().text();
    const parsed: unknown = body ? JSON.parse(body) : undefined;
    calls.push({ path, method: request.method, headers: request.headers, body: parsed });
    if (request.method === 'GET') {
      if (scenario === 'loading') return new Promise<Response>(() => {});
      if (readUnavailable) {
        readUnavailable = false;
        return json({ code: 'overloaded' }, 503);
      }
      if (scenario === 'missing' || deleted) return json({ code: 'not_found' }, 404);
      return json({ context });
    }
    // Current refusal precedes receipts, matching native authority on replay.
    if (refusal)
      return json(
        { code: refusal === 403 ? 'forbidden' : refusal === 422 ? 'idempotency_conflict' : 'invalid_request' },
        refusal,
      );
    if (scenario === 'global') return json({ code: 'forbidden' }, 403);
    if (scenario === 'expired' && path.endsWith(':restore')) return json({ code: 'conflict' }, 409);
    const key = request.headers.get('idempotency-key')!;
    if (receipts.has(key)) return json(receipts.get(key), path === '/v1/contexts' ? 201 : 200);
    let result: unknown;
    if (path === '/v1/contexts') {
      const posted = parsed as { labels: Record<string, string>; settings?: string };
      context = {
        ...context,
        labels: posted.labels,
        ...(posted.settings
          ? {
              settings: { id: posted.settings, release: 'released-settings-digest' },
              defaults: { 'schema:url': 'suppress' },
            }
          : {}),
      };
      result = { context };
    } else {
      deleted = request.method === 'DELETE';
      result = { context: { id: context.id, state: deleted ? 'deleted' : 'active' } };
    }
    receipts.set(key, result);
    if (uncertain) {
      uncertain = false;
      return json({ code: 'overloaded' }, 503);
    }
    return json(result, path === '/v1/contexts' ? 201 : 200);
  }) as typeof fetch;
  const client = createKernelClient('https://editorial.test', { fetch: fetcher });
  const transport: EditorialTransport = {
    read: (address) => readEditorialContext(client, 'Bearer fixture', address),
    submit: (command) => submitEditorialContext(client, 'Bearer fixture', command),
  };
  return {
    id: context.id,
    context,
    client,
    calls,
    transport,
    review,
    refuse: (status: number | undefined) => {
      refusal = status;
    },
  };
}
