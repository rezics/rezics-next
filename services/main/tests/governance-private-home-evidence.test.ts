import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { grantFixtureAuthority, registerFixtureIdentity } from '../src/modules/access/fixture-authority.ts';
import { GLOBAL_CONTEXT, GovernanceInvalid, GovernanceStore, type ReportInput } from '../src/modules/governance/store.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
let cluster: PostgresCluster | undefined;
let pool: Pool;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 4 });
  for (const file of schemaFiles(root, 'access')) {
    await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
  }
}, 60_000);
afterAll(async () => { await pool?.end(); cluster?.remove(); });

async function fixture(kind: ReportInput['kind'], evidenceDisclosure: string) {
  const principalId = randomUUID(), actor = native(), resource = native();
  const principal = { issuer: 'https://account.home-evidence.test', subject: randomUUID() };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await registerFixtureIdentity(client, { principalId, actor, ...principal });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  await grantFixtureAuthority(pool, { scope: 'governance:platform', requireDispatch: true,
    representations: [{ principalId, actor, action: 'governance.moderate', lifetime: 'infinity' }],
    grant: { actor, action: 'governance.moderate', lifetime: 'infinity' } });
  const target = { owner: 'graph' as const, resource, component: 'record' as const, revision: native(), locator: null };
  const store = new GovernanceStore(pool, { capture: async (_principal, actingSubject, selected) => {
    expect(actingSubject).toBe(actor);
    return { ...selected, state: 'available', representation: 'Retained home document.',
      revisionDigest: 'a'.repeat(64), provenance: { capturedBy: 'zone-home-exact-cut-v1', disclosure: evidenceDisclosure } };
  } }, { current: async () => target.revision, realmBasis: async () => null }, { current: async () => null });
  const input: ReportInput = { kind, actingSubject: actor,
    authority: { kind: 'platform', scopeId: 'governance:platform' }, context: GLOBAL_CONTEXT,
    target, evidence: [target], disclosure: 'private', reasonCode: 'spam', statement: 'Review this home.',
    idempotencyKey: randomUUID(), ...(kind === 'rights_complaint' ? { complaint: {
      process: 'ordinary_dispute', claimantKind: 'rights_holder', claimantName: 'Claimant', claimantContact: null,
      claimedWork: resource, claimedRight: 'copyright', noticeDigest: 'b'.repeat(64), noticeReceivedAt: new Date().toISOString(),
    } } : {}) };
  return { store, principal, input, resource };
}

for (const kind of ['content_report', 'rights_complaint'] as const) {
  for (const disclosure of ['parties', 'public_summary'] as const) {
    test(`${kind} refuses ${disclosure} disclosure for private home evidence before admission`, async () => {
      const f = await fixture(kind, 'private');
      await expect(f.store.submitReport(f.principal, { ...f.input, disclosure })).rejects.toBeInstanceOf(GovernanceInvalid);
      expect((await pool.query('SELECT 1 FROM access.governance_case WHERE target_resource=$1', [f.resource])).rowCount).toBe(0);
      expect((await pool.query('SELECT 1 FROM access.governance_report WHERE idempotency_key=$1',
        [f.input.idempotencyKey])).rowCount).toBe(0);
    });
  }
  for (const disclosure of ['private', 'parties', 'public_summary'] as const) {
    test(`${kind} admits ${disclosure} case disclosure for ${disclosure === 'private' ? 'private' : 'public'} home evidence`, async () => {
      const f = await fixture(kind, disclosure === 'private' ? 'private' : 'public');
      const result = await f.store.submitReport(f.principal, { ...f.input, disclosure });
      expect(result.evidence[0]?.state).toBe('available');
      expect((await pool.query('SELECT disclosure FROM access.governance_case WHERE id=$1',
        [result.caseId])).rows).toEqual([{ disclosure }]);
    });
  }
}
