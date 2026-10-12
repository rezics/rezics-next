import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { KnownEffectFailure } from '../src/modules/governance/effects.ts';
import {
  GLOBAL_CONTEXT, GovernanceDenied, GovernanceStore, type DecisionInput, type EvidenceTarget,
} from '../src/modules/governance/store.ts';
import { mintPartyCredential, PublicReports } from '../src/modules/public-report/store.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
let cluster: PostgresCluster | undefined;
let pool: Pool;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 6 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(root, 'access')) {
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}, 60_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
});

async function fixture(options: {
  hidden?: Partial<EvidenceTarget>;
  hiddenOnSameResource?: boolean;
  scopeKind?: 'component' | 'exact_revision';
  hiddenState?: 'confirmed' | 'pending' | 'failed';
  anonymousRevision?: string;
} = {}) {
  const principalId = randomUUID();
  const principal = { issuer: 'https://account.status.test', subject: randomUUID() };
  const actor = native();
  await pool.query('INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principalId, principal.issuer, principal.subject]);
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
  await grantFixtureAuthority(pool, {
    scope: 'governance:platform', requireDispatch: true,
    representations: [{ principalId, actor, action: 'governance.moderate', lifetime: 'infinity' }],
    grant: { actor, action: 'governance.moderate', lifetime: 'infinity' },
  });
  const a: EvidenceTarget = {
    owner: 'content', resource: native(), component: 'body', revision: native(), locator: null,
  };
  const b: EvidenceTarget = { ...a, resource: options.hiddenOnSameResource ? a.resource : native(),
    revision: options.hiddenOnSameResource ? a.revision : native(), ...options.hidden };
  const rule = { ref: 'urn:rule:status', revision: '1', digest: 'a'.repeat(64) };
  const capture = (target: EvidenceTarget) => ({
    ...target, state: 'available' as const, representation: 'Retained evidence.',
    revisionDigest: 'b'.repeat(64), provenance: {},
  });
  const store = new GovernanceStore(pool, { capture: async (_principal, _actor, target) => capture(target) },
    { current: async target => target.revision ?? [a, b].find(e => e.owner === target.owner
      && e.resource === target.resource && e.component === target.component && e.locator === target.locator)?.revision ?? null },
    { current: async () => rule }, {
      participants: async () => [],
      apply: async (_operationId, ordinal) => {
        const hiddenOrdinal = options.hiddenState ? 2 : 1;
        if (ordinal === hiddenOrdinal && options.hiddenState === 'failed') throw new KnownEffectFailure('private-error');
        return ordinal === hiddenOrdinal
          ? { receipt: 'private-receipt', continuation: options.hiddenState === 'pending' ? 'private-continuation' : null }
          : { receipt: 'public-receipt' };
      },
    });
  const privateReport = await store.submitReport(principal, {
    kind: 'content_report', actingSubject: actor,
    authority: { kind: 'platform', scopeId: 'governance:platform' }, context: GLOBAL_CONTEXT,
    target: a, disclosure: 'private', reasonCode: 'spam', statement: 'Review both targets.',
    evidence: [a, b], idempotencyKey: randomUUID(),
  });
  const publicTarget = { ...a, revision: options.anonymousRevision ?? a.revision };
  const reports = new PublicReports(pool, {
    resolve: async () => ({ evidence: capture(publicTarget), author: null, realm: null }),
  });
  const anonymous = await reports.submit({
    profile: 'public-report-v1', category: 'spam_or_manipulation', target: a.resource,
    statement: 'Review public A.', contentLanguage: 'en',
  }, randomUUID(), new Request('https://rezics.com/v1/public-reports'), null);
  expect(anonymous.caseId).toBe(privateReport.caseId);
  await store.safety.claim(principal, actor, privateReport.caseId);
  const target = (e: EvidenceTarget) => ({
    ...e, scopeKind: options.scopeKind ?? 'exact_revision' as const,
    revision: options.scopeKind === 'component' ? null : e.revision,
    expectedHead: e.revision,
    // Decision identity excludes locators; distinct effects let this fixture
    // exercise two cited locations without colliding with that unique key.
    effect: e === b && b.locator !== a.locator ? 'search' as const : 'disclosure' as const,
  });
  const input: DecisionInput = {
    caseId: privateReport.caseId, expectedGeneration: privateReport.caseGeneration,
    actingSubject: actor, outcome: 'restrict',
    targets: (options.hiddenState ? [a, b] : [b, a]).map(target), rule,
    evidenceDigest: privateReport.evidenceDigest, reversesDecisionId: null, answersStepId: null,
    rationale: null, disclosure: 'private', idempotencyKey: randomUUID(),
    reasons: { facts: 'Retained evidence reviewed.', scope: 'Cited targets.', duration: 'Until review.',
      automation: false, contentLanguage: 'en', appealRoute: '/v1/public-reports/{caseId}/correspondence' },
  };
  const decision = await store.decide(principal, input);
  const client = await pool.connect();
  let reporter: string;
  let affected: string;
  try {
    reporter = await mintPartyCredential(client, privateReport.caseId, privateReport.reportId, 'reporter');
    affected = await mintPartyCredential(client, privateReport.caseId, privateReport.reportId, 'affected');
  } finally { client.release(); }
  return { a, b, reports, anonymous, decision, reporter, affected, store, principal, actor };
}

test('anonymous status hides another report target and its receipts without exposing ordinal gaps; staff retains both', async () => {
  const f = await fixture();
  const status = await f.reports.status(f.anonymous.caseId, f.anonymous.credential);
  expect(status.operation).toEqual({
    operationId: f.decision.decisionId, status: 'completed', continuation: null,
    items: [{ ordinal: 1, target: f.a.resource, state: 'confirmed', receipt: 'public-receipt',
      continuation: null, error: null }],
  });
  expect(JSON.stringify(status)).not.toContain(f.b.resource);
  expect(JSON.stringify(status)).not.toContain('private-receipt');
  expect(f.decision.operation.items.map(item => item.target)).toEqual([f.b.resource, f.a.resource]);
  const staff = await f.store.resumeDecision(f.principal, f.actor, f.decision.decisionId);
  expect(staff.operation).toEqual(f.decision.operation);
  const ownReport = await f.reports.status(f.anonymous.caseId, f.reporter);
  expect(ownReport.operation).toEqual({
    operationId: f.decision.decisionId, status: 'completed', continuation: null,
    items: [
      { ordinal: 1, target: f.b.resource, state: 'confirmed', receipt: 'private-receipt', continuation: null, error: null },
      { ordinal: 2, target: f.a.resource, state: 'confirmed', receipt: 'public-receipt', continuation: null, error: null },
    ],
  });
});

for (const hiddenState of ['pending', 'failed'] as const) {
  test(`concealed ${hiddenState} progress does not change the anonymous operation status or continuation`, async () => {
    const f = await fixture({ hiddenState });
    expect(f.decision.operation.status).toBe('partial');
    const status = await f.reports.status(f.anonymous.caseId, f.anonymous.credential);
    expect(status.operation?.status).toBe('completed');
    expect(status.operation?.continuation).toBeNull();
    expect(status.operation?.items).toHaveLength(1);
    for (const concealed of [f.b.resource, 'private-receipt', 'private-continuation', 'private-error']) {
      expect(JSON.stringify(status)).not.toContain(concealed);
    }
  });
}

test('exact revision entitlement does not extend to another revision of the same resource', async () => {
  const f = await fixture({ anonymousRevision: native() });
  const status = await f.reports.status(f.anonymous.caseId, f.anonymous.credential);
  expect(status.operation).toBeNull();
});

for (const hidden of [{ owner: 'graph' }, { component: 'title' }, { locator: 'private-location' },
  { revision: 'urn:private:revision' }] satisfies Partial<EvidenceTarget>[]) {
  test(`report entitlement matches the full evidence grain: ${Object.keys(hidden)[0]}`, async () => {
    const f = await fixture({ hidden, hiddenOnSameResource: true });
    const status = await f.reports.status(f.anonymous.caseId, f.anonymous.credential);
    expect(status.operation?.items).toEqual([{ ordinal: 1, target: f.a.resource,
      state: 'confirmed', receipt: 'public-receipt', continuation: null, error: null }]);
    expect(JSON.stringify(status)).not.toContain('private-receipt');
  });
}

test('component decisions remain visible through retained evidence on a different revision', async () => {
  const f = await fixture({ scopeKind: 'component', anonymousRevision: native() });
  const status = await f.reports.status(f.anonymous.caseId, f.anonymous.credential);
  expect(status.operation?.items.map(item => item.target)).toEqual([f.a.resource]);
  expect(status.operation?.items[0]?.ordinal).toBe(1);
});

test('affected credentials cannot use an unrelated report as target entitlement; invalid credentials still deny', async () => {
  const f = await fixture();
  const status = await f.reports.status(f.anonymous.caseId, f.affected);
  expect(status.operation).toBeNull();
  await expect(f.reports.status(f.anonymous.caseId, 'a'.repeat(43))).rejects.toBeInstanceOf(GovernanceDenied);
  await expect(f.reports.status(randomUUID(), f.anonymous.credential)).rejects.toBeInstanceOf(GovernanceDenied);
});
