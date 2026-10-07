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

interface AggregateRow { statement: string; context_key: string; fit_negative: string; fit_positive: string; spoiler_none: string;
  spoiler_minor: string; spoiler_major: string; generation: string }
interface HintRow { concept: string; context_key: string; hint: Exclude<ConceptHint, 'unknown'> | null; generation: string }
interface EventRow { statement: string; context_key: string; id: string; kind: string; generation: string }

export interface JudgmentProtectionCheck {
  statement: string; context: JudgmentContext; generation: string;
  policyGeneration: 'wilson-v1'; conceptHint: ConceptHint;
  conceptHintGeneration: string; sourceEvent: string | null;
  protection: 'hide-major' | 'hide-any' | 'show-all';
  status: 'unknown' | 'major' | 'minor' | 'not-spoiler' | 'disputed';
  distribution: { notSpoiler: number; minorSpoiler: number; majorSpoiler: number };
  sampleSize: number;
}

export interface JudgmentBadgeTarget {
  statement: string; context: JudgmentContext; concept: string | null;
}

const targetKey = (statement: string, contextKey: string) => JSON.stringify([statement, contextKey]);

/** Consume the latest immutable invalidations for a page. Aggregate and hint
 * locks precede their dependent reads, so a writer we wait for cannot leave us
 * projecting an older event snapshot. All set writes and locks use key order
 * to prevent overlapping pages from taking the same rows in opposite orders. */
export async function projectJudgmentBadges(pool: Pool,
  targets: readonly JudgmentBadgeTarget[]): Promise<JudgmentProtectionCheck[]> {
  const inputs = targets.map(target => {
    const contextKey = judgmentContextKey(target.context);
    if (!native.test(target.statement) || (target.concept !== null && !native.test(target.concept))) {
      throw new Error('invalid judgment badge target');
    }
    return { ...target, contextKey };
  });
  if (!inputs.length) return [];
  const statements = inputs.map(input => input.statement);
  const contexts = inputs.map(input => input.contextKey);
  const concepts = inputs.map(input => input.concept);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const recovery = (await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
    if (recovery?.open !== true) throw new Error('Access is held for recovery');
    await client.query(`INSERT INTO access.judgment_aggregate (statement, context_key)
      SELECT DISTINCT statement, context_key FROM unnest($1::text[], $2::text[])
        AS targets(statement, context_key) ORDER BY statement, context_key
      ON CONFLICT DO NOTHING`, [statements, contexts]);
    const aggregates = new Map((await client.query<AggregateRow>(`SELECT aggregate.*
      FROM access.judgment_aggregate AS aggregate
      JOIN (SELECT DISTINCT statement, context_key FROM unnest($1::text[], $2::text[])
        AS targets(statement, context_key)) AS targets USING (statement, context_key)
      ORDER BY aggregate.statement, aggregate.context_key FOR SHARE OF aggregate`,
    [statements, contexts])).rows.map(row => [targetKey(row.statement, row.context_key), row]));
    const events = new Map((await client.query<EventRow>(`SELECT targets.statement, targets.context_key, event.*
      FROM (SELECT DISTINCT statement, context_key FROM unnest($1::text[], $2::text[])
        AS input(statement, context_key)) AS targets
      CROSS JOIN LATERAL (SELECT id, kind, generation FROM access.judgment_outbox
        WHERE statement = targets.statement AND context_key = targets.context_key
        ORDER BY generation DESC LIMIT 1) AS event`,
    [statements, contexts])).rows.map(row => [targetKey(row.statement, row.context_key), row]));
    await client.query(`INSERT INTO access.judgment_concept_hint (concept, context_key)
      SELECT DISTINCT concept, context_key FROM unnest($1::text[], $2::text[])
        AS targets(concept, context_key) WHERE concept IS NOT NULL ORDER BY concept, context_key
      ON CONFLICT DO NOTHING`, [concepts, contexts]);
    const hints = new Map((await client.query<HintRow>(`SELECT head.concept, head.context_key, head.hint, head.generation
      FROM access.judgment_concept_hint AS head
      JOIN (SELECT DISTINCT concept, context_key FROM unnest($1::text[], $2::text[])
        AS targets(concept, context_key) WHERE concept IS NOT NULL) AS targets USING (concept, context_key)
      ORDER BY head.concept, head.context_key FOR SHARE OF head`,
    [concepts, contexts])).rows.map(row => [targetKey(row.concept, row.context_key), row]));
    const results = inputs.map(input => {
      const aggregate = aggregates.get(targetKey(input.statement, input.contextKey))!;
      const event = events.get(targetKey(input.statement, input.contextKey));
      if ((event?.generation ?? '0') !== aggregate.generation
        || (event && !['judgment.aggregate.invalidated.v1',
          'judgment.aggregate.baselined.v1'].includes(event.kind))) {
        throw new Error('judgment aggregate is missing its invalidation event');
      }
      const head = input.concept === null ? undefined : hints.get(targetKey(input.concept, input.contextKey))!;
      const hint: ConceptHint = head?.hint ?? 'unknown';
      const counts: JudgmentCounts = { fitNegative: count(aggregate.fit_negative),
        fitPositive: count(aggregate.fit_positive), spoilerNone: count(aggregate.spoiler_none),
        spoilerMinor: count(aggregate.spoiler_minor), spoilerMajor: count(aggregate.spoiler_major) };
      const badge = judgmentBadgeProjectionRecipe(counts, hint);
      return { statement: input.statement, context: input.context, generation: aggregate.generation,
        policyGeneration: badge.policyGeneration, conceptHint: hint,
        conceptHintGeneration: head?.generation ?? '0', sourceEvent: event?.id ?? null,
        protection: badge.protection, status: badge.status,
        distribution: badge.distribution, sampleSize: badge.sampleSize };
    });
    // A page can repeat a target with different concept hints. Return every
    // result, but persist the last occurrence just as sequential calls do.
    const projections = new Map(inputs.map((input, index) => [targetKey(input.statement, input.contextKey), {
      statement: input.statement, context_key: input.contextKey, concept: input.concept,
      source_event: results[index]!.sourceEvent, generation: results[index]!.generation,
      hint_generation: results[index]!.conceptHintGeneration,
      policy_generation: results[index]!.policyGeneration, protection: results[index]!.protection,
      status: results[index]!.status, sample_size: results[index]!.sampleSize,
      distribution: results[index]!.distribution,
    }]));
    await client.query(`INSERT INTO access.judgment_badge_projection
      (statement, context_key, source_event, generation, concept, hint_generation,
        policy_generation, protection, status, sample_size, distribution)
      SELECT statement, context_key, source_event, generation, concept, hint_generation,
        policy_generation, protection, status, sample_size, distribution
      FROM jsonb_to_recordset($1::jsonb) AS badges(statement text, context_key text,
        source_event uuid, generation bigint, concept text, hint_generation bigint,
        policy_generation text, protection text, status text, sample_size bigint, distribution jsonb)
      ORDER BY statement, context_key
      ON CONFLICT (statement, context_key) DO UPDATE SET
        source_event = EXCLUDED.source_event, generation = EXCLUDED.generation,
        concept = EXCLUDED.concept, hint_generation = EXCLUDED.hint_generation,
        policy_generation = EXCLUDED.policy_generation,
        protection = EXCLUDED.protection, status = EXCLUDED.status,
        sample_size = EXCLUDED.sample_size, distribution = EXCLUDED.distribution,
        updated_at = clock_timestamp()
      WHERE access.judgment_badge_projection.generation <= EXCLUDED.generation`,
    [JSON.stringify([...projections.values()])]);
    await client.query('COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function projectJudgmentBadge(pool: Pool, statement: string,
  context: JudgmentContext, concept: string | null): Promise<JudgmentProtectionCheck> {
  return (await projectJudgmentBadges(pool, [{ statement, context, concept }]))[0]!;
}
