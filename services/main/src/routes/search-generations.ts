import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { assertPublicContentSearchReady } from '../modules/content-publication/search.ts';
import { assertPublicTextReady, readCurrentSearchGeneration, SearchIndexUnavailable,
  withStableSearchSnapshot } from '../modules/work/search-readiness.ts';
import { ContentProjectionUnavailable } from '../modules/content-publication/relay.ts';
import { problemResult } from '../api-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';

const decimal = t.String({ pattern: '^(0|[1-9][0-9]*)$' });
const generation = t.String({ pattern: '^urn:rezics:text-index-generation:[0-9a-f-]{36}$' });
const currentGeneration = t.Object({
  contractVersion: t.Literal('1'),
  profile: t.Nullable(t.String()),
  state: t.Union([t.Literal('active'), t.Literal('uncertain'), t.Literal('quarantined'),
    t.Literal('restore-held'), t.Literal('unqualified'), t.Literal('over-budget')]),
  dataEpoch: t.String(),
  sequence: decimal,
  generation: t.Nullable(generation),
  activation: t.Nullable(t.Object({ receipt: t.String(), graphSequence: decimal,
    priorGeneration: generation, sourceCut: t.Object({ dataEpoch: t.String(), sequence: decimal },
      { additionalProperties: false }), indexDigest: t.String({ pattern: '^[0-9a-f]{64}$' }) },
  { additionalProperties: false })),
  population: t.Nullable(t.Integer({ minimum: 0 })),
}, { additionalProperties: false });

/**
 * `GET /v1/search/generations/current` (OPS15/OPS16): one control read plus the
 * public text gate, under the public search wall/call/byte budget. It exposes
 * only positions, generation identities and the activation receipt, never text.
 */
export function searchGenerationRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const qualify = async () => {
    if (!work.contentProjection) return assertPublicTextReady(fuseki, work.environment.lineage);
    const { content, cursor, consumer } = work.contentProjection;
    try {
      await assertPublicContentSearchReady(work.environment, content, cursor, consumer);
    } catch (error) {
      if (error instanceof ContentProjectionUnavailable) {
        throw new SearchIndexUnavailable('Content projection is behind its source', { cause: error });
      }
      throw error;
    }
    return assertPublicTextReady(fuseki, work.environment.lineage);
  };
  return new Elysia()
    .get('/v1/search/generations/current', {
      response: { 200: currentGeneration, 503: problemResult(503) },
    }, async () => {
      try {
        const current = await withStableSearchSnapshot(fuseki,
          () => readCurrentSearchGeneration(fuseki, work.environment.lineage, qualify));
        return Response.json(current, { headers: { 'cache-control': 'no-store' } });
      } catch {
        return problem(503, 'search_generation_unavailable',
          'The current search generation cannot be read');
      }
    });
}
