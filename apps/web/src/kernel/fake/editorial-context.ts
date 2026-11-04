import { createKernelClient } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import { contextFixture } from './context-curation';
import { candidateContext } from '../../subject/candidates';
import {
  readEditorialCreationActions,
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
  | 'deleted'
  | 'unretained'
  | 'unavailable'
  | 'unavailable-actions'
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
  let deleted = scenario === 'deleted' || scenario === 'unretained';
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
    if (request.method === 'POST' && path === '/v1/viewerActions') {
      if (scenario === 'unavailable-actions') return json({ code: 'overloaded' }, 503);
      const refs = (parsed as { resources?: { type: string; id: string }[] }).resources ?? [];
      return json({
        resources: refs.map(({ type, id }) => {
          if (type !== 'semantic.context') return { type, id, error: 'not_found' };
          const actions =
            id === PAGE_GLOBAL_CONTEXT
              ? [{ action: 'context:create', operations: ['context.create'] }]
              : id !== context.id || (deleted && scenario === 'expired')
                ? null
                : deleted && scenario === 'unretained'
                  ? [{ action: 'context:read', operations: ['context.get'] }]
                  : deleted
                    ? [
                        { action: 'context:read', operations: ['context.get'] },
                        { action: 'context:restore', operations: ['context.restore'] },
                      ]
                    : [
                        { action: 'context:read', operations: ['context.get'] },
                        { action: 'context:delete', operations: ['context.delete'] },
                      ];
          return actions ? { type, id, viewerActions: actions } : { type, id, error: 'not_found' };
        }),
      });
    }
    if (request.method === 'GET') {
      if (scenario === 'loading') return new Promise<Response>(() => {});
      if (readUnavailable) {
        readUnavailable = false;
        return json({ code: 'overloaded' }, 503);
      }
      if (path.endsWith('/lifecycle')) {
        if (scenario === 'missing' || (deleted && scenario === 'expired')) return json({ code: 'not_found' }, 404);
        return json({
          context: {
            id: context.id,
            kind: context.kind,
            labels: context.labels,
            state: deleted ? 'deleted' : 'active',
            deletedAt: deleted ? '2026-01-01T00:00:00.000000Z' : null,
            purgeAfter: deleted && scenario !== 'unretained' ? '2026-01-31T00:00:00.000000Z' : null,
          },
        });
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
    creation: (session) => readEditorialCreationActions(client, 'Bearer fixture', session),
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
