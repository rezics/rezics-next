import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { advanceFixtureAuthorityGeneration, fixtureAuthorityScenario, setFixtureGrantDeadline,
  setFixtureMandateState, setFixtureMembershipState } from '../src/modules/access/fixture-authority-scenario.ts';
import { ASSESS_ACTION, ASSESS_SCOPE, PUBLIC_DOMAIN_TEXT_USE, publicDomainWorkMaterial,
  RightsDenied, RightsStore, type AssessmentInput } from '../src/modules/rights/store.ts';

let cluster: PostgresCluster, pool: Pool, store: RightsStore;
beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 4 });
  const root = resolve(import.meta.dir, '../../..');
  for (const file of schemaFiles(root, 'access')) {
    await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
  }
  await migrateContent(pool);
  store = new RightsStore(pool, pool);
}, 120_000);
afterAll(async () => {
  await pool?.end();
  cluster?.remove();
});

function assessment(actingSubject: string): AssessmentInput {
  return { actingSubject, material: publicDomainWorkMaterial(`https://rezics.com/id/${randomUUID()}`),
    ...PUBLIC_DOMAIN_TEXT_USE, expressionKind: 'expression', basis: 'public_domain', outcome: 'supported',
    licenseInstrument: null, exceptionKind: null, rationale: 'Public-domain text', extent: {}, evidence: {},
    obligations: [], expectedAssessment: null, idempotencyKey: randomUUID() };
}

for (const scenario of [
  { name: 'unrelated Work creation mandate', mandate: 'work.create' },
  { name: 'expired assessment mandate', mandate: ASSESS_ACTION, mandateState: 'expired' },
  { name: 'revoked assessment mandate', mandate: ASSESS_ACTION, mandateState: 'revoked' },
  { name: 'ended membership grant', mandate: ASSESS_ACTION, membership: 'left' },
  { name: 'prior membership generation grant', mandate: 'agent.control', membership: 'stale' },
] as const) {
  test(`rights assessments and private evaluations deny an ${scenario.name}`, async () => {
    const authority = await fixtureAuthorityScenario(pool, { scope: ASSESS_SCOPE, action: ASSESS_ACTION,
      ...scenario });
    const input = assessment(authority.actor);
    await expect(store.assess(authority.principal, input)).rejects.toBeInstanceOf(RightsDenied);
    await expect(store.evaluate(authority.principal, authority.actor, input.material, input))
      .rejects.toBeInstanceOf(RightsDenied);
    expect((await pool.query('SELECT id FROM rights.use_assessment WHERE idempotency_key = $1',
      [input.idempotencyKey])).rowCount).toBe(0);
  });
}

for (const mandate of [ASSESS_ACTION, 'agent.control']) {
  for (const membership of [undefined, 'joined'] as const) {
    test(`rights assessments accept ${mandate} with a ${membership ?? 'direct'} grant`, async () => {
      const authority = await fixtureAuthorityScenario(pool, { scope: ASSESS_SCOPE, action: ASSESS_ACTION,
        mandate, membership });
      const input = assessment(authority.actor);
      const result = await store.assess(authority.principal, input);
      expect(result).toMatchObject({ basis: 'public_domain', outcome: 'supported', replayed: false });
      expect(await store.evaluate(authority.principal, authority.actor, input.material, input))
        .toEqual({ status: 'assessed', assessment: expect.objectContaining({ assessmentId: result.assessmentId }) });
      expect(await store.assess(authority.principal, input)).toMatchObject({ assessmentId: result.assessmentId,
        replayed: true });
    });
  }
}

for (const ended of ['grant', 'expiry', 'mandate', 'membership', 'principal', 'representation',
  'authority_subject', 'permission_grant', 'scope_gate', 'recovery_fence'] as const) {
  test(`assessment rolls back its prepared Content effect when ${ended} ends at the head wait`, async () => {
    const authority = await fixtureAuthorityScenario(pool, { scope: ASSESS_SCOPE, action: ASSESS_ACTION,
      mandate: ASSESS_ACTION, membership: 'joined' });
    const input = assessment(authority.actor);
    const previous = await store.assess(authority.principal, input);
    const next = { ...input, expectedAssessment: previous.assessmentId, idempotencyKey: randomUUID(),
      obligations: [{ kind: 'attribution' as const, instrument: 'https://example.test/credit', appliesTo: 'display' as const, notice: 'Credit' }] };
    const blocker = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM rights.use_assessment_head WHERE assessment_id = $1 FOR UPDATE', [previous.assessmentId]);
      if (ended === 'expiry') await setFixtureGrantDeadline(pool, authority.grantId, 250);
      pending = store.assess(authority.principal, next).catch(error => error);
      let waiting = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        waiting = (await pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
          AND query LIKE 'SELECT assessment_id,%'`)).rowCount! > 0;
        if (waiting) break;
        await Bun.sleep(5);
      }
      expect(waiting).toBe(true);
      if (ended === 'expiry') await Bun.sleep(275);
      else if (ended === 'grant') await setFixtureGrantDeadline(pool, authority.grantId, -1000);
      else if (ended === 'mandate') await setFixtureMandateState(pool, authority.representationId, 'revoked');
      else if (ended === 'membership') await setFixtureMembershipState(pool, authority.membershipId!, 'left');
      else await advanceFixtureAuthorityGeneration(pool, ended, ended === 'principal' ? authority.principalId
        : ended === 'representation' ? authority.representationId : ended === 'authority_subject' ? authority.actor
        : ended === 'permission_grant' ? authority.grantId : ended === 'scope_gate' ? ASSESS_SCOPE : 'true');
      await blocker.query('COMMIT');
      expect(await pending).toBeInstanceOf(RightsDenied);
      expect((await pool.query('SELECT id FROM rights.use_assessment WHERE idempotency_key = $1', [next.idempotencyKey])).rowCount).toBe(0);
      expect((await pool.query('SELECT assessment_id FROM rights.use_assessment_head WHERE material_id = $1', [previous.materialId])).rows)
        .toEqual([{ assessment_id: previous.assessmentId }]);
      expect((await pool.query(`SELECT 1 FROM rights.obligation o JOIN rights.use_assessment a ON a.id = o.assessment_id
        WHERE a.material_id = $1`, [previous.materialId])).rowCount).toBe(0);
      if (['grant', 'expiry', 'mandate', 'membership'].includes(ended)) {
        await expect(store.assess(authority.principal, input)).rejects.toBeInstanceOf(RightsDenied);
      }
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pending;
    }
  });
}
