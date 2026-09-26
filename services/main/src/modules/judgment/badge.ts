import type { Pool } from 'pg';
import { judgmentBadgeProjectionRecipe }
  from '../content-publication/projection-recipes.ts';
import { type JudgmentCounts } from './policy.ts';
import { judgmentContextKey, type ConceptHint, type JudgmentContext } from './schema.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const count = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('judgment aggregate exceeds safe range');
  return parsed;
};

interface AggregateRow { fit_negative: string; fit_positive: string; spoiler_none: string;
  spoiler_minor: string; spoiler_major: string; generation: string }
interface HintRow { hint: Exclude<ConceptHint, 'unknown'> | null; generation: string }
interface EventRow { id: string; kind: string; generation: string }

export interface JudgmentProtectionCheck {
  statement: string; context: JudgmentContext; generation: string;
  policyGeneration: 'wilson-v1'; conceptHint: ConceptHint;
  conceptHintGeneration: string; sourceEvent: string | null;
  protection: 'hide-major' | 'hide-any' | 'show-all';
  status: 'unknown' | 'major' | 'minor' | 'not-spoiler' | 'disputed';
  distribution: { notSpoiler: number; minorSpoiler: number; majorSpoiler: number };
  sampleSize: number;
}

/** Consume the latest immutable invalidation for one exact target/population.
 * Intermediate generations are coalesced only after a locked read of the current
 * aggregate. The badge records the event and generation it actually projects. */
export async function projectJudgmentBadge(pool: Pool, statement: string,
  context: JudgmentContext, concept: string | null): Promise<JudgmentProtectionCheck> {
  const contextKey = judgmentContextKey(context);
  if (!native.test(statement) || (concept !== null && !native.test(concept))) {
    throw new Error('invalid judgment badge target');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const recovery = (await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
    if (recovery?.open !== true) throw new Error('Access is held for recovery');
    await client.query(`INSERT INTO access.judgment_aggregate (statement, context_key)
      VALUES ($1, $2) ON CONFLICT DO NOTHING`, [statement, contextKey]);
    const aggregate = (await client.query<AggregateRow>(`SELECT * FROM access.judgment_aggregate
      WHERE statement = $1 AND context_key = $2 FOR SHARE`, [statement, contextKey])).rows[0]!;
    const event = (await client.query<EventRow>(`SELECT id, kind, generation FROM access.judgment_outbox
      WHERE statement = $1 AND context_key = $2 ORDER BY generation DESC LIMIT 1`,
    [statement, contextKey])).rows[0];
    if ((event?.generation ?? '0') !== aggregate.generation
      || (event && !['judgment.aggregate.invalidated.v1',
        'judgment.aggregate.baselined.v1'].includes(event.kind))) {
      throw new Error('judgment aggregate is missing its invalidation event');
    }
    let hint: ConceptHint = 'unknown';
    let hintGeneration = '0';
    if (concept) {
      await client.query(`INSERT INTO access.judgment_concept_hint (concept, context_key)
        VALUES ($1, $2) ON CONFLICT DO NOTHING`, [concept, contextKey]);
      const head = (await client.query<HintRow>(`SELECT hint, generation
        FROM access.judgment_concept_hint WHERE concept = $1 AND context_key = $2 FOR SHARE`,
      [concept, contextKey])).rows[0]!;
      hint = head.hint ?? 'unknown';
      hintGeneration = head.generation;
    }
    const counts: JudgmentCounts = { fitNegative: count(aggregate.fit_negative),
      fitPositive: count(aggregate.fit_positive), spoilerNone: count(aggregate.spoiler_none),
      spoilerMinor: count(aggregate.spoiler_minor), spoilerMajor: count(aggregate.spoiler_major) };
    const badge = judgmentBadgeProjectionRecipe(counts, hint);
    await client.query(`INSERT INTO access.judgment_badge_projection
      (statement, context_key, source_event, generation, concept, hint_generation,
        policy_generation, protection, status, sample_size, distribution)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      ON CONFLICT (statement, context_key) DO UPDATE SET
        source_event = EXCLUDED.source_event, generation = EXCLUDED.generation,
        concept = EXCLUDED.concept, hint_generation = EXCLUDED.hint_generation,
        policy_generation = EXCLUDED.policy_generation,
        protection = EXCLUDED.protection, status = EXCLUDED.status,
        sample_size = EXCLUDED.sample_size, distribution = EXCLUDED.distribution,
        updated_at = clock_timestamp()
      WHERE access.judgment_badge_projection.generation <= EXCLUDED.generation`,
    [statement, contextKey, event?.id ?? null, aggregate.generation, concept, hintGeneration,
      badge.policyGeneration, badge.protection, badge.status, badge.sampleSize,
      JSON.stringify(badge.distribution)]);
    await client.query('COMMIT');
    return { statement, context, generation: aggregate.generation,
      policyGeneration: badge.policyGeneration, conceptHint: hint,
      conceptHintGeneration: hintGeneration, sourceEvent: event?.id ?? null,
      protection: badge.protection, status: badge.status,
      distribution: badge.distribution, sampleSize: badge.sampleSize };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
