import type { Pool } from 'pg';
import { status, t } from 'elysia';
import type { createApp } from '../http/app.ts';
import type { Access } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { ProblemError } from '../http/problem-error.ts';
import { problemSchema } from '../http/problem.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { createKnowledgeDiscoverySource } from './native-bindings.ts';
import { createKnowledgeDiscovery } from './knowledge-discovery.ts';
import { createKnowledgeDiscoveryStore } from './knowledge-discovery-native.ts';
import { searchHttpExecute, searchHttpPrincipal } from './http/search.ts';
import {
  KnowledgeDiscoveryId, KnowledgeDiscoveryQuerySchema, KnowledgeDiscoveryPageSchema,
  KnowledgeDiscoveryPreparingSchema,
} from './http/discovery/knowledge.ts';

/** Mounted by the ordinary Search route builder, so OpenAPI and KernelClient see the real operation. */
export function knowledgeDiscoveryRoutes<App>(app: App, options: {
  pool: Pool;
  tokens?: KeyRing;
  access: () => Access | undefined;
  now: () => number;
}) {
  const store = createKnowledgeDiscoveryStore(options.pool, options.now);
  const routed = (app as ReturnType<typeof createApp>).get('/v1/subjects/:subjectId/knowledgeDocuments', {
    params: t.Object({ subjectId: KnowledgeDiscoveryId }, { additionalProperties: false }),
    query: KnowledgeDiscoveryQuerySchema(),
    response: {
      200: KnowledgeDiscoveryPageSchema(),
      202: KnowledgeDiscoveryPreparingSchema(),
      400: problemSchema('invalid_request'),
      401: problemSchema('authentication_required', 'invalid_credentials'),
      403: problemSchema('forbidden'),
      404: problemSchema('not_found'),
      409: problemSchema('search_restart_required'),
      503: problemSchema('semantic_not_ready', 'index_not_ready', 'overloaded', 'deadline_exceeded'),
    },
    detail: {
      operationId: 'knowledge_document.discover',
      description: 'Current public Knowledge selections for one original Subject, in publication order. Follow 202 continuations until a useful page or exhaustion. No total is exposed.',
      'x-exposure': 'gate:search',
      'x-action': 'subject:read',
      security: [{ bearerAuth: [] }, {}],
    },
  }, async ({ params, query, authorize, admission, job, actor, set }) => {
    set.headers['cache-control'] = 'private, no-store';
    const route = routeOf(params.subjectId)!;
    const check = await authorize({ route, id: params.subjectId,
      eligibility: subjectReadEligibility({ route, id: params.subjectId }) });
    return admission.run('normal', job, async () => {
      if (!(await withConnection(options.pool, (client) => check(client)))) throw new ProblemError('not_found');
      const access = options.access();
      if (!access || !options.tokens || !createKnowledgeDiscoverySource)
        throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
      const source = createKnowledgeDiscoverySource({ pool: options.pool, access });
      const discover = createKnowledgeDiscovery({ store, source, tokens: options.tokens, now: options.now });
      return searchHttpExecute(query, async () => {
        const page = await discover(params.subjectId, searchHttpPrincipal(actor), query, { deadline: job.deadline });
        if (page.state === 'unavailable')
          throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
        if (page.state === 'preparing') return status(202, page);
        return status(200, { ...page, documents: [...page.documents] });
      });
    });
  });
  return routed as typeof routed & App;
}
