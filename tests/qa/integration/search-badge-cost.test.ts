import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import type { JudgmentBadgeTarget, JudgmentProtectionCheck }
  from '../../../services/main/src/modules/judgment/badge.ts';
import { judgmentContextKey, judgmentDigest }
  from '../../../services/main/src/modules/judgment/schema.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../../../services/main/src/modules/media/store.ts';
import { disclosePublicSearchFields, PUBLIC_DISCLOSURE_COST, PublicDisclosureUnavailable }
  from '../../../services/main/src/modules/search-disclosure/public-fields.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { queryPublicDisclosedFields }
  from '../../../services/main/src/modules/work/search-disclosed-fields.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable }
  from '../../../services/main/src/modules/work/search-budget.ts';
import { protectClassifiedResults, type SearchRouteDependencies }
  from '../../../services/main/src/routes/search.ts';
import { contextFixture, nativeId } from './context-fixture.ts';
import { meterStatements } from './feed-read-support.ts';

let pool: Pool;
let judgments: AccessJudgments;
const principalId = randomUUID();
const principal = { issuer: 'https://search-badge-cost.test', subject: principalId };
const global = { kind: 'global' as const };

beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through isolated QA integration');
  }
  pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 8 });
  judgments = new AccessJudgments(pool);
  await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1,$2,$3)`, [principalId, principal.issuer, principal.subject]);
});

afterAll(async () => { await pool?.end(); });

async function seedAggregate(database: Pool, target: JudgmentBadgeTarget,
  none: number, major = 0) {
  await database.query(`INSERT INTO access.judgment_aggregate
    (statement, context_key, spoiler_none, spoiler_major)
    VALUES ($1,$2,$3,$4)`, [target.statement, judgmentContextKey(target.context), none, major]);
}

async function measured<T>(read: () => Promise<T>) {
  const meter = meterStatements();
  try {
    const result = await read();
    expect(meter.violations).toEqual([]);
    return { result, statements: meter.count() };
  } finally { meter.restore(); }
}

const dependencies = (owner = judgments) => ({ judgments: owner }) as SearchRouteDependencies;

function relation(targets: readonly JudgmentBadgeTarget[]) {
  return { total: targets.length, results: targets.map((target, index) => ({
    work: nativeId(), score: index + 0.5,
    classification: { meaningKey: `urn:rezics:meaning:${index}`, concept: target.concept!,
      supportingStatements: [target.statement],
      source: target.context.kind === 'realm' ? 'local' : 'inherited-global' },
  })) };
}

async function perItem(targets: readonly JudgmentBadgeTarget[], owner = judgments) {
  const badges: JudgmentProtectionCheck[] = [];
  for (const target of targets) {
    badges.push(await owner.protectionCheck(target.statement, target.context, target.concept));
  }
  return badges;
}

test('classified search pages of 1 and 100 have constant SQL cost and exact per-item badges', async () => {
  const realm = nativeId();
  const concepts = [nativeId(), nativeId()];
  const targets: JudgmentBadgeTarget[] = Array.from({ length: 100 }, (_, index) => ({
    statement: nativeId(), context: index % 2 ? { kind: 'realm', realm } : global,
    concept: concepts[index % concepts.length]!,
  }));
  for (const target of targets) await seedAggregate(pool, target, 40);
  const costs: number[] = [];
  for (const size of [1, 100]) {
    const page = relation(targets.slice(0, size));
    // The first read creates projections; the second must still consult Access.
    for (let pass = 0; pass < 2; pass++) {
      const measuredPage = await measured(() => protectClassifiedResults(dependencies(), page, realm));
      costs.push(measuredPage.statements);
      const singles = await perItem(targets.slice(0, size));
      expect(measuredPage.result).toEqual({ ...page, results: page.results.map((item, index) => ({
        ...item, classification: { ...item.classification, supportingStatementCount: 1,
          protectionChecks: [singles[index]!] },
      })) });
      expect(singles.every(badge => badge.protection === 'show-all')).toBe(true);
    }
  }
  expect(costs).toEqual([11, 11, 11, 11]);
}, 60_000);

test('sparse protected supports and a withdrawn judgment retain per-item filtering and counts', async () => {
  const concept = nativeId();
  const targets: JudgmentBadgeTarget[] = Array.from({ length: 100 }, () => ({
    statement: nativeId(), context: global, concept,
  }));
  const hidden = new Set([9, 49, 89]);
  for (const [index, target] of targets.entries()) {
    // Missing aggregates remain conservatively protected, as do explicit major votes.
    if (index === 49) continue;
    await seedAggregate(pool, target, hidden.has(index) ? 0 : 40, hidden.has(index) ? 40 : 0);
  }
  const revoked = targets[0]!;
  await pool.query(`UPDATE access.judgment_aggregate SET spoiler_none = 3
    WHERE statement = $1 AND context_key = 'global'`, [revoked.statement]);
  const vote = { statement: revoked.statement, context: global, dimension: 'spoiler' as const,
    value: 0, expectedRevision: '0', idempotencyKey: randomUUID(),
    requestDigest: judgmentDigest(revoked.statement) };
  const written = await judgments.write(principal, vote);
  const page = relation(targets);
  // One visible alternative preserves this result when its first support is hidden.
  page.results[9]!.classification.supportingStatements.push(targets[10]!.statement);
  const read = async () => {
    const badges = await perItem(targets);
    const byStatement = new Map(badges.map(badge => [badge.statement, badge]));
    const expected = page.results.flatMap(item => {
      const checks = item.classification.supportingStatements.map(statement => byStatement.get(statement)!)
        .filter(badge => badge.protection === 'show-all');
      return checks.length ? [{ ...item, classification: { ...item.classification,
        supportingStatements: checks.map(badge => badge.statement),
        supportingStatementCount: checks.length, protectionChecks: checks } }] : [];
    });
    const result = await measured(() => protectClassifiedResults(dependencies(), page));
    expect(result.statements).toBe(11);
    expect(result.result).toEqual({ total: expected.length, results: expected });
    return result.result;
  };
  const before = await read();
  expect(before.total).toBe(98);
  expect(before.results[0]!.classification.protectionChecks[0]).toMatchObject({
    statement: revoked.statement, generation: '1', sampleSize: 4, protection: 'show-all' });
  await judgments.write(principal, { ...vote, value: null,
    expectedRevision: written.revision, idempotencyKey: randomUUID() });
  const after = await read();
  expect(after.total).toBe(97);
  expect(after.results.some(item => item.classification.supportingStatements.includes(revoked.statement)))
    .toBe(false);
  expect(await judgments.protectionCheck(revoked.statement, global, concept))
    .toMatchObject({ generation: '2', sampleSize: 3, protection: 'hide-major' });
}, 60_000);

test('classified support limits and missing judgment dependencies still fail closed before SQL', async () => {
  const target = { statement: nativeId(), context: global, concept: nativeId() };
  const oversized = relation([target]);
  oversized.results[0]!.classification.supportingStatements = Array.from({ length: 513 }, nativeId);
  const meter = meterStatements();
  try {
    await expect(protectClassifiedResults(dependencies(), oversized))
      .rejects.toBeInstanceOf(PublicQueryBudgetExceeded);
    await expect(protectClassifiedResults({} as SearchRouteDependencies, relation([target])))
      .rejects.toBeInstanceOf(PublicQueryUnavailable);
    expect(meter.count()).toBe(0);
  } finally { meter.restore(); }
});

test('classified search rejects incomplete or reordered badge pages without returning partial results', async () => {
  const targets = Array.from({ length: 2 }, () => ({
    statement: nativeId(), context: global, concept: nativeId(),
  }));
  for (const target of targets) await seedAggregate(pool, target, 40);
  const badges = await perItem(targets);
  for (const response of [badges.slice(0, 1), [...badges].reverse(),
    [{ ...badges[0]!, context: { kind: 'realm' as const, realm: nativeId() } }, badges[1]!]]) {
    const work = { judgments: { protectionChecks: async () => response } } as unknown as SearchRouteDependencies;
    await expect(protectClassifiedResults(work, relation(targets)))
      .rejects.toBeInstanceOf(PublicQueryUnavailable);
  }
});

test('public field search batches both badge passes at its existing cap and fences withdrawal', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const phrase = `badge${randomUUID().replaceAll('-', '')}`;
    const realm = await f.realm(phrase);
    const rows = (await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?space WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?space rv:realmCapability ${iri(realm.realm)} . }
    }`)).results?.bindings ?? [];
    expect(rows).toHaveLength(1);
    const space = rows[0]!.space!.value;
    await f.grant('semantic:create:root', 'semantic.change');
    const definition = await f.json<{ component: string; revision: string }>(await f.call('POST',
      '/v1/semantic/changes', { profile: 'semantic-change-v1', expectedHead: null,
        state: { component: 'definition', kind: 'property' }, actingSubject: f.actorA }), 201);
    await f.grant(`semantic:read:${definition.component}`, 'semantic.read');
    const predicate = definition.component;
    await f.grant('context:create:root', 'context.create');
    const context = await f.json<{ context: string; semanticRevision: string }>(await f.call('POST',
      '/v1/contexts', { profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
        entries: [{ target: space, relation: predicate, state: 'defined', definition: nativeId(),
          applicability: [] }], actingSubject: f.actorA }), 201);
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    await f.globalAcceptance();
    await f.grant('classification:decide:global', 'statement.decide');
    const statements: Array<{ statement: string; acceptance: typeof global }> = [];
    for (let index = 0; index < PUBLIC_DISCLOSURE_COST.statements; index++) {
      const written = await f.json<{ statement: string }>(await f.call('POST', '/v1/statements', {
        profile: 'statement-v1', speaker: { kind: 'personal' }, subject: space,
        predicate, relationDefinition: definition.revision, value: { kind: 'resource', iri: space },
        applicability: [], interpretation: { kind: 'explicit', context: context.context,
          semanticRevision: context.semanticRevision }, evidence: [], actingSubject: f.actorA }), 201);
      await f.json(await f.call('POST', '/v1/statement-decisions', { profile: 'statement-decision-v1',
        target: { kind: 'statement', statement: written.statement }, acceptance: global,
        expectedDecisionHead: null, outcome: 'accepted', actingSubject: f.actorA }), 201);
      statements.push({ statement: written.statement, acceptance: global });
      await seedAggregate(f.accessPool, { statement: written.statement, context: global, concept: null }, 40);
    }
    expect(new Set(statements.map(item => item.statement)).size).toBe(PUBLIC_DISCLOSURE_COST.statements);
    const owner = new AccessJudgments(f.accessPool);
    const base = { contexts: [], resources: [], mediaContext: DEFAULT_MEDIA_CONTEXT, language: 'en' };
    const costs: number[] = [];
    for (const size of [1, PUBLIC_DISCLOSURE_COST.statements]) {
      f.resetQueries();
      const page = await measured(() => disclosePublicSearchFields(f.env, undefined, owner,
        { ...base, statements: statements.slice(0, size) }));
      costs.push(page.statements);
      expect(page.result.fields).toEqual(statements.slice(0, size).map(item => ({
        kind: 'statement-value', owner: item.statement, subject: space,
        text: expect.stringContaining(phrase), language: 'und',
      })));
      expect(page.result.cost.badgeChecks).toBe(size * 2);
      expect(page.result.cost.badgeChecks).toBeLessThanOrEqual(PUBLIC_DISCLOSURE_COST.badgeChecks);
      expect(f.queries()).toBeLessThanOrEqual(PUBLIC_DISCLOSURE_COST.graphQueries);
    }
    expect(costs).toEqual([22, 22]);
    const input = { ...base, statements, profile: 'public-disclosed-fields-phrase-v1' as const, phrase };
    const matched = await measured(() => queryPublicDisclosedFields(f.env, undefined, owner, input));
    expect(matched.statements).toBe(22);
    expect(matched.result.total).toBe(PUBLIC_DISCLOSURE_COST.statements);

    // An actual judgment withdrawal crosses the policy threshold while summaries
    // are being hydrated, so the second page must reject the stale first pass.
    const revoked = statements[0]!.statement;
    await f.accessPool.query(`UPDATE access.judgment_aggregate SET spoiler_none = 3
      WHERE statement = $1 AND context_key = 'global'`, [revoked]);
    const vote = { statement: revoked, context: global, dimension: 'spoiler' as const,
      value: 0, expectedRevision: '0', idempotencyKey: randomUUID(), requestDigest: judgmentDigest(revoked) };
    const member = { issuer: f.account.issuer, subject: f.account.a.id };
    const written = await owner.write(member, vote);
    let passes = 0;
    const moving = { protectionChecks: async (targets: readonly JudgmentBadgeTarget[]) => {
      if (++passes === 2) await owner.write(member, { ...vote, value: null,
        expectedRevision: written.revision, idempotencyKey: randomUUID() });
      return owner.protectionChecks(targets);
    } };
    await expect(disclosePublicSearchFields(f.env, undefined, moving, { ...base, statements }))
      .rejects.toBeInstanceOf(PublicDisclosureUnavailable);
    expect(passes).toBe(2);
    const refreshed = await queryPublicDisclosedFields(f.env, undefined, owner, input);
    expect(refreshed.total).toBe(PUBLIC_DISCLOSURE_COST.statements - 1);
    expect(refreshed.results.some(item => item.owner === revoked)).toBe(false);
  } finally { await f.close(); }
}, 120_000);
