import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { fixtureAuthorityScenario } from '../src/modules/access/fixture-authority-scenario.ts';
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
  { name: 'expired control mandate', mandate: 'agent.control', mandateState: 'expired' },
  { name: 'revoked control mandate', mandate: 'agent.control', mandateState: 'revoked' },
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
