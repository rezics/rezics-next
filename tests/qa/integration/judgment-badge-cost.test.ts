import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { judgmentBadgeProjectionRecipe }
  from '../../../services/main/src/modules/content-publication/projection-recipes.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { projectJudgmentBadge, projectJudgmentBadges, type JudgmentProtectionCheck }
  from '../../../services/main/src/modules/judgment/badge.ts';
import type { JudgmentCounts } from '../../../services/main/src/modules/judgment/policy.ts';
import { judgmentContextKey, judgmentDigest, type ConceptHint, type JudgmentContext }
  from '../../../services/main/src/modules/judgment/schema.ts';
import { meterStatements } from './feed-read-support.ts';

type Target = { statement: string; context: JudgmentContext; concept: string | null };
const native = () => `https://rezics.com/id/${randomUUID()}`;
const global: JudgmentContext = { kind: 'global' };
const emptyCounts: JudgmentCounts = { fitNegative: 0, fitPositive: 0,
  spoilerNone: 0, spoilerMinor: 0, spoilerMajor: 0 };
let pool: Pool;
const principalId = randomUUID();
const principal = { issuer: 'https://badge-cost.test', subject: principalId };

beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through isolated QA integration');
  }
  pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 8 });
  await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1,$2,$3)`, [principalId, principal.issuer, principal.subject]);
});

afterAll(async () => { await pool?.end(); });

async function seedAggregate(target: Target, counts: JudgmentCounts, generation = '3') {
  const contextKey = judgmentContextKey(target.context);
  await pool.query(`INSERT INTO access.judgment_aggregate
    (statement, context_key, fit_negative, fit_positive,
      spoiler_none, spoiler_minor, spoiler_major, generation)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [target.statement, contextKey,
    counts.fitNegative, counts.fitPositive, counts.spoilerNone,
    counts.spoilerMinor, counts.spoilerMajor, generation]);
  const event = randomUUID();
  await pool.query(`INSERT INTO access.judgment_outbox
    (id, kind, statement, context_key, generation)
    VALUES ($1,'judgment.aggregate.baselined.v1',$2,$3,$4)`,
  [event, target.statement, contextKey, generation]);
  return event;
}

async function seedHint(concept: string, context: JudgmentContext,
  hint: Exclude<ConceptHint, 'unknown'>) {
  await pool.query(`INSERT INTO access.judgment_concept_hint
    (concept, context_key, hint, generation, declared_by_principal)
    VALUES ($1,$2,$3,1,$4)`, [concept, judgmentContextKey(context), hint, principalId]);
}

function expectedBadge(target: Target, counts: JudgmentCounts, hint: ConceptHint,
  generation: string, sourceEvent: string | null, hintGeneration = '1'): JudgmentProtectionCheck {
  return { statement: target.statement, context: target.context, generation,
    sourceEvent, conceptHint: hint, conceptHintGeneration: hintGeneration,
    ...judgmentBadgeProjectionRecipe(counts, hint) };
}

async function measure(targets: readonly Target[]) {
  const meter = meterStatements();
  try {
    const badges = await projectJudgmentBadges(pool, targets);
    expect(meter.violations).toEqual([]);
    return { badges, statements: meter.count() };
  } finally { meter.restore(); }
}

test('badge pages of 1, 5 and 20 keep one constant SQL cost and the per-item results', async () => {
  const realm: JudgmentContext = { kind: 'realm', realm: native() };
  const concept = native();
  await seedHint(concept, global, 'major');
  await seedHint(concept, realm, 'minor');
  const statements = Array.from({ length: 20 }, native);
  const scenarios: { counts: JudgmentCounts; protection: JudgmentProtectionCheck['protection'];
    status: JudgmentProtectionCheck['status'] }[] = [
    { counts: emptyCounts, protection: 'hide-major', status: 'unknown' },
    { counts: { ...emptyCounts, spoilerNone: 40 }, protection: 'show-all', status: 'not-spoiler' },
    { counts: { ...emptyCounts, spoilerMinor: 40 }, protection: 'hide-any', status: 'minor' },
    { counts: { ...emptyCounts, spoilerMajor: 40 }, protection: 'hide-major', status: 'major' },
    { counts: { ...emptyCounts, fitNegative: 100, fitPositive: 100,
      spoilerNone: 8, spoilerMinor: 8, spoilerMajor: 8 }, protection: 'hide-major', status: 'disputed' },
  ];
  const targets: Target[] = [];
  const expected: JudgmentProtectionCheck[] = [];
  for (let index = 0; index < 20; index++) {
    const target = { statement: statements[index]!,
      context: index % 2 ? realm : global, concept };
    const scenario = scenarios[index % scenarios.length]!;
    const counts = scenario.counts;
    const generation = index % scenarios.length ? String(index + 1) : '0';
    const event = generation === '0' ? null : await seedAggregate(target, counts, generation);
    const hint = index % 2 ? 'minor' : 'major';
    const badge = expectedBadge(target, counts, hint, generation, event);
    // Concrete policy outcomes catch regressions shared by the wrapper and batch.
    expect(badge).toMatchObject({ status: scenario.status,
      protection: generation === '0' && index % 2 ? 'hide-any' : scenario.protection,
      distribution: { notSpoiler: counts.spoilerNone, minorSpoiler: counts.spoilerMinor,
        majorSpoiler: counts.spoilerMajor },
      sampleSize: counts.spoilerNone + counts.spoilerMinor + counts.spoilerMajor });
    targets.push(target);
    expected.push(badge);
  }
  const costs: number[] = [];
  for (const size of [1, 5, 20]) {
    const page = targets.slice(0, size);
    const cold = await measure(page);
    const warm = await measure(page);
    costs.push(cold.statements, warm.statements);
    expect(cold.badges).toEqual(expected.slice(0, size));
    expect(warm.badges).toEqual(cold.badges);
    const singles = [];
    for (const target of page) singles.push(await projectJudgmentBadge(pool,
      target.statement, target.context, target.concept));
    expect(cold.badges).toEqual(singles);
  }
  expect(costs).toEqual([11, 11, 11, 11, 11, 11]);
}, 30_000);

test('mixed and duplicate targets preserve order, exact context, and each supplied concept', async () => {
  const realm: JudgmentContext = { kind: 'realm', realm: native() };
  const statement = native(), major = native(), minor = native(), safe = native(), unknown = native();
  await seedHint(major, global, 'major');
  await seedHint(major, realm, 'not-spoiler');
  await seedHint(minor, global, 'minor');
  await seedHint(safe, global, 'not-spoiler');
  const target = { statement, context: global, concept: major };
  const targets: Target[] = [target, { ...target, concept: minor },
    { ...target, concept: null }, { ...target, context: realm },
    { ...target, concept: unknown }, { ...target, concept: safe }, { ...target, concept: minor }];
  const expected = targets.map((item, index) => expectedBadge(item, emptyCounts,
    (['major', 'minor', 'unknown', 'not-spoiler', 'unknown', 'not-spoiler', 'minor'] as const)[index]!,
    '0', null, index === 2 || index === 4 ? '0' : '1'));
  const result = await measure(targets);
  expect(result.statements).toBe(11);
  expect(result.badges).toEqual(expected);
  expect(result.badges.map(badge => badge.protection))
    .toEqual(['hide-major', 'hide-any', 'hide-any', 'show-all', 'hide-any', 'show-all', 'hide-any']);
  // Sequential calls persist the last duplicate's concept for the exact key.
  const stored = (await pool.query<{ context_key: string; concept: string | null; protection: string }>(`
    SELECT context_key, concept, protection FROM access.judgment_badge_projection
    WHERE statement = $1 ORDER BY context_key`, [statement])).rows;
  expect(stored).toContainEqual({ context_key: 'global', concept: minor, protection: 'hide-any' });
  expect(stored).toContainEqual({ context_key: realm.realm, concept: major, protection: 'show-all' });
  expect(stored).toHaveLength(2);
  expect((await pool.query(`SELECT generation FROM access.judgment_concept_hint
    WHERE concept = $1 AND context_key = 'global'`, [unknown])).rows)
    .toEqual([{ generation: '0' }]);
  for (let index = 0; index < targets.length; index++) {
    const item = targets[index]!;
    expect(await projectJudgmentBadge(pool, item.statement, item.context, item.concept))
      .toEqual(result.badges[index]!);
  }

  const noConcepts = targets.slice(0, 3).map(item => ({ ...item, concept: null }));
  expect(await projectJudgmentBadges(pool, noConcepts))
    .toEqual(noConcepts.map(item => expectedBadge(item, emptyCounts, 'unknown', '0', null, '0')));
}, 30_000);

test('empty pages and invalid targets do no SQL and never persist a partial page', async () => {
  const valid: Target = { statement: native(), context: global, concept: native() };
  const invalid: Target[] = [{ ...valid, statement: 'https://elsewhere.test/id' },
    { ...valid, concept: 'https://elsewhere.test/concept' },
    { ...valid, context: { kind: 'realm', realm: 'invalid-realm' } }];
  const meter = meterStatements();
  try {
    expect(await projectJudgmentBadges(pool, [])).toEqual([]);
    for (const target of invalid) {
      await expect(projectJudgmentBadges(pool, [valid, target])).rejects.toThrow();
    }
    expect(meter.count()).toBe(0);
  } finally { meter.restore(); }
  expect((await pool.query(`SELECT statement FROM access.judgment_aggregate
    WHERE statement = $1`, [valid.statement])).rows).toEqual([]);
  expect((await pool.query(`SELECT concept FROM access.judgment_concept_hint
    WHERE concept = $1`, [valid.concept])).rows).toEqual([]);
});

test('a missing latest invalidation rolls back new rows and existing projections for the whole page', async () => {
  const good: Target = { statement: native(), context: global, concept: null };
  const fresh: Target = { statement: native(), context: global, concept: native() };
  const broken: Target = { statement: native(), context: global, concept: native() };
  await seedAggregate(good, { ...emptyCounts, spoilerNone: 40 }, '1');
  await projectJudgmentBadge(pool, good.statement, global, null);
  const before = (await pool.query(`SELECT * FROM access.judgment_badge_projection
    WHERE statement = $1`, [good.statement])).rows;
  await pool.query(`UPDATE access.judgment_aggregate SET spoiler_none = 0,
    spoiler_major = 40, generation = 2 WHERE statement = $1`, [good.statement]);
  await pool.query(`INSERT INTO access.judgment_outbox
    (id, kind, statement, context_key, generation)
    VALUES ($1,'judgment.aggregate.baselined.v1',$2,'global',2)`, [randomUUID(), good.statement]);
  const previousEvent = await seedAggregate(broken, { ...emptyCounts, spoilerMinor: 40 }, '1');
  await pool.query(`UPDATE access.judgment_aggregate SET generation = 2
    WHERE statement = $1`, [broken.statement]);
  await expect(projectJudgmentBadges(pool, [good, fresh, broken]))
    .rejects.toThrow('judgment aggregate is missing its invalidation event');
  expect((await pool.query(`SELECT * FROM access.judgment_badge_projection
    WHERE statement = $1`, [good.statement])).rows).toEqual(before);
  expect((await pool.query(`SELECT statement FROM access.judgment_aggregate
    WHERE statement = $1`, [fresh.statement])).rows).toEqual([]);
  expect((await pool.query(`SELECT statement FROM access.judgment_badge_projection
    WHERE statement = ANY($1::text[])`, [[fresh.statement, broken.statement]])).rows).toEqual([]);
  expect((await pool.query(`SELECT concept FROM access.judgment_concept_hint
    WHERE concept = ANY($1::text[])`, [[fresh.concept, broken.concept]])).rows).toEqual([]);

  const currentEvent = randomUUID();
  await pool.query(`INSERT INTO access.judgment_outbox
    (id, kind, statement, context_key, generation)
    VALUES ($1,'judgment.aggregate.baselined.v1',$2,'global',2)`, [currentEvent, broken.statement]);
  const recovered = await projectJudgmentBadges(pool, [good, fresh, broken]);
  expect(recovered[0]).toMatchObject({ generation: '2', status: 'major' });
  expect(recovered[1]).toMatchObject({ generation: '0', sourceEvent: null });
  expect(recovered[2]).toMatchObject({ generation: '2', sourceEvent: currentEvent, status: 'minor' });
  expect(recovered[2]!.sourceEvent).not.toBe(previousEvent);
});

test('unsafe aggregate counts abort the batch after hint rows are read without retaining new rows', async () => {
  const fresh: Target = { statement: native(), context: global, concept: native() };
  const unsafe: Target = { statement: native(), context: global, concept: native() };
  await seedAggregate(unsafe, emptyCounts, '1');
  await pool.query(`UPDATE access.judgment_aggregate SET spoiler_major = 9007199254740992
    WHERE statement = $1`, [unsafe.statement]);
  await expect(projectJudgmentBadges(pool, [fresh, unsafe]))
    .rejects.toThrow('judgment aggregate exceeds safe range');
  expect((await pool.query(`SELECT statement FROM access.judgment_aggregate
    WHERE statement = $1`, [fresh.statement])).rows).toEqual([]);
  expect((await pool.query(`SELECT concept FROM access.judgment_concept_hint
    WHERE concept = ANY($1::text[])`, [[fresh.concept, unsafe.concept]])).rows).toEqual([]);
  expect((await pool.query(`SELECT statement FROM access.judgment_badge_projection
    WHERE statement = ANY($1::text[])`, [[fresh.statement, unsafe.statement]])).rows).toEqual([]);
});

test('the recovery fence holds the complete page and reopening it permits a fresh projection', async () => {
  const targets: Target[] = Array.from({ length: 5 }, () => ({
    statement: native(), context: global, concept: native() }));
  await pool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
  try {
    await expect(projectJudgmentBadges(pool, targets)).rejects.toThrow('Access is held for recovery');
    expect((await pool.query(`SELECT statement FROM access.judgment_aggregate
      WHERE statement = ANY($1::text[])`, [targets.map(target => target.statement)])).rows).toEqual([]);
    expect((await pool.query(`SELECT concept FROM access.judgment_concept_hint
      WHERE concept = ANY($1::text[])`, [targets.map(target => target.concept)])).rows).toEqual([]);
  } finally {
    await pool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
  }
  expect(await projectJudgmentBadges(pool, targets)).toEqual(targets.map(target =>
    expectedBadge(target, emptyCounts, 'unknown', '0', null, '0')));
});

test('overlapping reversed pages and a concurrent judgment never corrupt ordering or generations', async () => {
  const concept = native();
  const targets: Target[] = Array.from({ length: 5 }, () => ({ statement: native(), context: global, concept }));
  const reverse = [...targets].reverse();
  const [forwardBadges, reverseBadges] = await Promise.all([
    projectJudgmentBadges(pool, targets), projectJudgmentBadges(pool, reverse),
  ]);
  expect(forwardBadges).toEqual(targets.map(target =>
    expectedBadge(target, emptyCounts, 'unknown', '0', null, '0')));
  expect(reverseBadges).toEqual([...forwardBadges].reverse());

  const statement = targets[0]!.statement;
  const intent = { statement, context: global, dimension: 'spoiler' as const, value: 2,
    expectedRevision: '0', idempotencyKey: randomUUID(), requestDigest: judgmentDigest(statement) };
  const [written, racedBadges] = await Promise.all([
    new AccessJudgments(pool).write(principal, intent), projectJudgmentBadges(pool, reverse),
  ]);
  expect(written.revision).toBe('1');
  const raced = racedBadges.at(-1)!;
  expect(['0', '1']).toContain(raced.generation);
  expect(raced).toMatchObject(raced.generation === '0'
    ? { status: 'unknown', sampleSize: 0, sourceEvent: null }
    : { status: 'major', sampleSize: 1, distribution: {
      notSpoiler: 0, minorSpoiler: 0, majorSpoiler: 1 } });
  const current = await projectJudgmentBadges(pool, targets);
  const event = (await pool.query<{ id: string; generation: string }>(`
    SELECT id, generation FROM access.judgment_outbox
    WHERE statement = $1 AND context_key = 'global'`, [statement])).rows[0]!;
  expect(event.generation).toBe('1');
  expect(current[0]).toEqual(expectedBadge(targets[0]!,
    { ...emptyCounts, spoilerMajor: 1 }, 'unknown', '1', event.id, '0'));
  expect((await pool.query<{ generation: string; source_event: string }>(`
    SELECT generation, source_event FROM access.judgment_badge_projection
    WHERE statement = $1 AND context_key = 'global'`, [statement])).rows)
    .toEqual([{ generation: '1', source_event: event.id }]);
}, 30_000);

test('a page waiting for an aggregate writer binds the newly committed invalidation', async () => {
  const target: Target = { statement: native(), context: global, concept: native() };
  const fresh: Target = { statement: native(), context: global, concept: target.concept };
  const previousEvent = await seedAggregate(target, { ...emptyCounts, spoilerNone: 40 }, '1');
  const currentEvent = randomUUID();
  const writer = await pool.connect();
  let pending: Promise<JudgmentProtectionCheck[]> | undefined;
  try {
    const pid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await writer.query('BEGIN');
    await writer.query(`UPDATE access.judgment_aggregate SET generation = 2,
      spoiler_none = 0, spoiler_major = 40 WHERE statement = $1 AND context_key = 'global'`,
    [target.statement]);
    await writer.query(`INSERT INTO access.judgment_outbox
      (id, kind, statement, context_key, generation)
      VALUES ($1,'judgment.aggregate.baselined.v1',$2,'global',2)`, [currentEvent, target.statement]);
    pending = projectJudgmentBadges(pool, [fresh, target]);
    void pending.catch(() => undefined);
    // Observe a real PostgreSQL wait before committing, rather than assuming
    // that a scheduler delay made the reader reach the aggregate lock.
    const deadline = performance.now() + 1_000;
    let blocked = false;
    while (performance.now() < deadline) {
      blocked = (await pool.query(`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND $1::integer = ANY(pg_blocking_pids(pid))`, [pid])).rowCount! > 0;
      if (blocked) break;
      await delay(10);
    }
    expect(blocked).toBe(true);
    await writer.query('COMMIT');
    const badges = await pending;
    expect(badges).toEqual([
      expectedBadge(fresh, emptyCounts, 'unknown', '0', null, '0'),
      expectedBadge(target, { ...emptyCounts, spoilerMajor: 40 }, 'unknown', '2', currentEvent, '0'),
    ]);
    expect(badges[1]!.sourceEvent).not.toBe(previousEvent);
    expect((await pool.query(`SELECT generation, source_event FROM access.judgment_badge_projection
      WHERE statement = $1 AND context_key = 'global'`, [target.statement])).rows)
      .toEqual([{ generation: '2', source_event: currentEvent }]);
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
    await pending?.catch(() => undefined);
  }
}, 10_000);
