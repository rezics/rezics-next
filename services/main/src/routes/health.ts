import { horizonHealth, latestHorizonHealth } from '../modules/horizon/lag.ts';
import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { assertCommandProfiles } from '../infrastructure/profile.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { assertPublicTextReady } from '../modules/work/search-readiness.ts';
import { assertPublicContentSearchReady } from '../modules/content-publication/search.ts';
import { occurrenceLabelReadiness } from '../modules/structure/label-index-backfill.ts';
import { mainSchemaReady } from '../schema-ready.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workRead } from '../modules/work/read-session.ts';
import { ratingProjectionHealth, readRatingProjectionHealth } from '../modules/rating/projection-health.ts';
import { discoveryRankingHealth, readDiscoveryRankingHealth } from '../modules/discovery/public-ranking.ts';
import { feedProjectionHealth, readFeedProjectionHealth } from '../modules/home/projection-health.ts';

export function healthRoutes(fuseki: FusekiClient, work?: MainWorkDependencies) {
  return new Elysia()
    .get('/health/live', {
      response: t.Object({ status: t.Literal('ok') }),
    }, () => ({ status: 'ok' as const }))
    .get('/health/ready', {
      response: {
        200: t.Object({ status: t.Literal('ready'), horizons: t.Optional(horizonHealth) }),
        503: t.Object({ status: t.Literal('unavailable') }),
      },
    }, async ({ status }) => {
      try {
        const result = await fuseki.query('ASK {}');
        if (result.boolean !== true) throw new Error('unexpected Fuseki result');
        if (process.env.NODE_ENV === 'production') await mainSchemaReady();
        if (work) {
          await assertCommandProfiles(fuseki);
          await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        }
        return { status: 'ready' as const, horizons: latestHorizonHealth() };
      } catch {
        return status(503, { status: 'unavailable' as const });
      }
    })
    .get('/health/rating-ready', {
      response: {
        200: ratingProjectionHealth,
        503: t.Union([ratingProjectionHealth, t.Object({ status: t.Literal('unavailable') })]),
      },
    }, async ({ status }) => {
      if (!work) return status(503, { status: 'unavailable' as const });
      try {
        const health = await workRead(work, new Request('http://main.internal/health/rating-ready'), {}, readRatingProjectionHealth);
        return health.status === 'unavailable' ? status(503, health) : health;
      } catch {
        return status(503, { status: 'unavailable' as const });
      }
    })
    .get('/health/discovery-ready', {
      response: {
        200: discoveryRankingHealth,
        503: t.Union([discoveryRankingHealth, t.Object({ status: t.Literal('unavailable') })]),
      },
    }, async ({ status }) => {
      if (!work) return status(503, { status: 'unavailable' as const });
      try {
        const health = await workRead(work, new Request('http://main.internal/health/discovery-ready'), {}, readDiscoveryRankingHealth);
        return health.status === 'unavailable' ? status(503, health) : health;
      } catch {
        return status(503, { status: 'unavailable' as const });
      }
    })
    .get('/health/feed-ready', {
      response: {
        200: feedProjectionHealth,
        503: t.Object({ status: t.Literal('unavailable') }),
      },
    }, async ({ status }) => {
      if (!work) return status(503, { status: 'unavailable' as const });
      try {
        return await workRead(work, new Request('http://main.internal/health/feed-ready'), {}, readFeedProjectionHealth);
      } catch { return status(503, { status: 'unavailable' as const }); }
    })
    .get('/health/search-ready', {
      response: {
        200: t.Object({ status: t.Union([t.Literal('ready'), t.Literal('indexing')]), dataEpoch: t.String(),
          sequence: t.String(), indexGeneration: t.String(), occurrenceLabels: t.Object({
            status: t.Union([t.Literal('current'), t.Literal('indexing')]),
            pending: t.Object({ value: t.Integer({ minimum: 0, maximum: 1 }), kind: t.Literal('at-least') }) }) }),
        503: t.Object({ status: t.Literal('unavailable') }),
      },
    }, async ({ status }) => {
      if (!work) return status(503, { status: 'unavailable' as const });
      try {
        const occurrenceLabels = await occurrenceLabelReadiness(work.environment);
        const ready = occurrenceLabels.status === 'indexing' ? 'indexing' as const : 'ready' as const;
        if (work.contentProjection) {
          const { content, cursor, consumer } = work.contentProjection;
          const projection = await assertPublicContentSearchReady(work.environment, content, cursor, consumer);
          return { status: ready, occurrenceLabels, dataEpoch: projection.graphPosition.dataEpoch,
            sequence: projection.graphPosition.sequence, indexGeneration: projection.indexGeneration };
        }
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const index = await assertPublicTextReady(fuseki, work.environment.lineage);
        return { status: ready, occurrenceLabels, dataEpoch: index.dataEpoch,
          sequence: index.sequence, indexGeneration: index.generation };
      } catch {
        return status(503, { status: 'unavailable' as const });
      }
    });
}

export const openApiOperations = {
  '/health/search-ready': { get: { exposure: 'public', rateLimitFamily: 'read' } },
  '/health/feed-ready': { get: { exposure: 'public', rateLimitFamily: 'read' } },
  '/health/discovery-ready': { get: { exposure: 'public', rateLimitFamily: 'read' } },
  '/health/rating-ready': { get: { exposure: 'public', rateLimitFamily: 'read' } },
  '/health/ready': { get: { exposure: 'public', rateLimitFamily: 'read' } },
  '/health/live': { get: { exposure: 'public', rateLimitFamily: 'read' } },
} as const;
