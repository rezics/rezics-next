import { t } from 'elysia';
import { pageFields, readId, readPosition, workCard } from '../work/read-contract.ts';
import { RANKING_COST } from './projection.ts';

export const rankingMetric = t.Union([t.Literal('reads'), t.Literal('finished-chapters'), t.Literal('reviews')]);
export const rankingInterval = t.Union([t.Literal('day'), t.Literal('week'), t.Literal('month')]);
export const rankingPage = t.Object({
  profile: t.Union([t.Literal('read-rankings-v1'), t.Literal('rising-v1')]),
  realm: t.Nullable(readId), metric: rankingMetric, interval: rankingInterval,
  bucket: t.String({ format: 'date' }), contentPosition: readPosition,
  items: t.Array(t.Object({ ...workCard.properties,
    score: t.Integer({ minimum: 0 }), growth: t.Integer() }), { maxItems: RANKING_COST.pageSize }),
  ...pageFields,
});
