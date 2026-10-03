import { t } from 'elysia';
import { readPosition } from '../work/read-contract.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { optionalPreview } from '../query/optional-preview.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from './global.ts';
import { RATING_STANDING_CADENCE } from './context.ts';

export const ratingProjectionHealth = t.Object({
  status: t.Union([t.Literal('ready'), t.Literal('unavailable'), t.Literal('not-configured')]),
  sourcePosition: readPosition,
  context: t.Nullable(t.String()),
  projectionPosition: t.Nullable(readPosition),
  sequenceLag: t.Nullable(t.String({ pattern: '^(0|[1-9][0-9]*)$' })),
});
export const RATING_PROJECTION_HEALTH_COST = { contexts: 1, graphCalls: 3, generationReads: 1, workPayloads: 0 } as const;

/** Same first Global standing question as Work previews. Constant-size Context
 * lookup and generation probe; no Work payloads, aggregation or refresh writes. */
export async function readRatingProjectionHealth(session: WorkReadSession) {
  const contexts = await session.query(`SELECT ?context WHERE { GRAPH ${iri(GRAPHS.current)} {
    ?context a rv:GlobalRatingContext ; rv:ratingPopulationOwner ${iri(GLOBAL_RATING_POPULATION_OWNER)} ;
      rv:contextState rv:Active ; rv:targetGrain rv:MainVersion ; rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} .
  } } ORDER BY STR(?context) LIMIT ${RATING_PROJECTION_HEALTH_COST.contexts}`, RATING_PROJECTION_HEALTH_COST.contexts);
  const context = contexts[0]?.context?.value ?? null;
  if (contexts.length && !context) throw new WorkReadUnavailable('Global rating Context is ambiguous');
  if (!context) return { status: 'not-configured' as const, sourcePosition: session.position,
    context, projectionPosition: null, sequenceLag: null };
  const generation = await optionalPreview(session, async () => session.deps.discovery?.active(
    { scope: 'global', realm: null, context, owner: null }, session.position));
  const lag = generation && generation.source_epoch === session.position.dataEpoch
    ? BigInt(session.position.sequence) - BigInt(generation.source_sequence) : null;
  return { status: generation && !generation.stale ? 'ready' as const : 'unavailable' as const,
    sourcePosition: session.position, context,
    projectionPosition: generation ? { dataEpoch: generation.source_epoch, sequence: generation.source_sequence } : null,
    sequenceLag: lag !== null && lag >= 0n ? String(lag) : null };
}
