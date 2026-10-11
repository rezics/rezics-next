import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import {
  startPostgresCluster,
  type PostgresCluster,
} from '../../../tests/qa/support/postgres-cluster.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import {
  GLOBAL_CONTEXT,
  GovernanceConflict,
  GovernanceDenied,
  GovernanceStore,
  type DecisionInput,
  type DecisionResult,
} from '../src/modules/governance/store.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const rule = { ref: 'urn:rule:replay', revision: '1', digest: 'a'.repeat(64) };
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
  } finally {
    client.release();
  }
}, 60_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
});

async function fixture() {
  const principalId = randomUUID();
  const principal: VerifiedPrincipal = {
    issuer: 'https://account.replay.test',
    subject: randomUUID(),
  };
  const actor = native();
  const resource = native();
  const revision = native();
  await pool.query(
    'INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principalId, principal.issuer, principal.subject],
  );
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
  const authority = await grantFixtureAuthority(pool, {
    scope: 'governance:platform',
    requireDispatch: true,
    representations: [{ principalId, actor, action: 'governance.moderate', lifetime: 'infinity' }],
    grant: { actor, action: 'governance.moderate', lifetime: 'infinity' },
  });
  let rendezvous: (() => Promise<void>) | undefined;
  let applications = 0;
  const store = new GovernanceStore(
    pool,
    {
      capture: async (_principal, _actor, target) => ({
        ...target,
        state: 'available',
        representation: 'Retained title.',
        revisionDigest: 'b'.repeat(64),
        provenance: {},
      }),
    },
    { current: async () => revision },
    {
      current: async (_ref, _scope, client) => {
        if (!client && rendezvous) await rendezvous();
        return rule;
      },
    },
    {
      participants: async () => [],
      apply: async (operationId, ordinal) => {
        applications++;
        return { receipt: `urn:receipt:${operationId}:${ordinal}` };
      },
    },
  );
  const target = {
    owner: 'graph' as const,
    resource,
    component: 'title' as const,
    revision,
    locator: null,
  };
  const report = await store.submitReport(principal, {
    kind: 'content_report',
    actingSubject: actor,
    authority: { kind: 'platform', scopeId: 'governance:platform' },
    context: GLOBAL_CONTEXT,
    target,
    disclosure: 'private',
    reasonCode: 'spam',
    statement: 'Review the retained title.',
    evidence: [target],
    idempotencyKey: randomUUID(),
  });
  await store.safety.claim(principal, actor, report.caseId);
  const input: DecisionInput = {
    caseId: report.caseId,
    expectedGeneration: report.caseGeneration,
    actingSubject: actor,
    outcome: 'restrict',
    targets: [
      { ...target, scopeKind: 'exact_revision', expectedHead: revision, effect: 'disclosure' },
    ],
    rule,
    evidenceDigest: report.evidenceDigest,
    reversesDecisionId: null,
    answersStepId: null,
    rationale: null,
    disclosure: 'private',
    idempotencyKey: randomUUID(),
    reasons: {
      facts: 'Staff reviewed the retained title.',
      scope: 'One title revision.',
      duration: 'Until reconsidered.',
      automation: false,
      contentLanguage: 'en',
      appealRoute: '/v1/public-reports/{caseId}/correspondence',
    },
  };
  return {
    store,
    principal,
    actor,
    input,
    grantId: authority.grantId,
    applications: () => applications,
    overlapNextPair() {
      let arrive = 0;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Rule preflight follows the first replay lookup. Both requests must have
      // missed that lookup before either can reach the real PostgreSQL case lock.
      rendezvous = async () => {
        if (++arrive === 2) {
          rendezvous = undefined;
          release();
        }
        await ready;
      };
    },
  };
}

async function expectOneDecision(input: DecisionInput, decisionId: string) {
  const decisions = await pool.query<{ id: string }>(
    'SELECT id FROM access.moderation_decision WHERE case_id = $1',
    [input.caseId],
  );
  expect(decisions.rows).toEqual([{ id: decisionId }]);
  const current = (
    await pool.query<{ generation: string; decision_head: string }>(
      'SELECT generation::text,decision_head FROM access.governance_case WHERE id = $1',
      [input.caseId],
    )
  ).rows[0]!;
  expect(current).toEqual({
    generation: (BigInt(input.expectedGeneration) + 1n).toString(),
    decision_head: decisionId,
  });
  expect(
    (
      await pool.query('SELECT 1 FROM access.outbox WHERE moderation_decision_id = $1', [
        decisionId,
      ])
    ).rowCount,
  ).toBe(1);
}

function outcome(result: DecisionResult) {
  const { replayed: _replayed, ...retained } = result;
  return retained;
}

test('overlapping same-key platform decisions replay one completed outcome and one effect', async () => {
  const f = await fixture();
  f.overlapNextPair();
  const results = await Promise.all([
    f.store.decide(f.principal, f.input),
    f.store.decide(f.principal, f.input),
  ]);
  expect(outcome(results[0]!)).toEqual(outcome(results[1]!));
  expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
  expect(results[0]!.operation.status).toBe('completed');
  expect(f.applications()).toBe(1);
  await expectOneDecision(f.input, results[0]!.decisionId);
});

test('a sequential same-key retry replays after the case generation advanced', async () => {
  const f = await fixture();
  const first = await f.store.decide(f.principal, f.input);
  const retry = await f.store.decide(f.principal, f.input);
  expect(retry.replayed).toBe(true);
  expect(outcome(retry)).toEqual(outcome(first));
  expect(f.applications()).toBe(1);
  await expectOneDecision(f.input, first.decisionId);
});

test('a retained key with a different body conflicts after the generation advanced', async () => {
  const f = await fixture();
  const first = await f.store.decide(f.principal, f.input);
  await expect(
    f.store.decide(f.principal, { ...f.input, rationale: 'Different request.' }),
  ).rejects.toBeInstanceOf(GovernanceConflict);
  expect(f.applications()).toBe(1);
  await expectOneDecision(f.input, first.decisionId);
});

test('overlapping same-key decisions with different bodies conflict under the case lock', async () => {
  const f = await fixture();
  f.overlapNextPair();
  const results = await Promise.allSettled([
    f.store.decide(f.principal, f.input),
    f.store.decide(f.principal, { ...f.input, rationale: 'Different request.' }),
  ]);
  const succeeded = results.filter((result) => result.status === 'fulfilled');
  const refused = results.filter((result) => result.status === 'rejected');
  expect(succeeded).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect(refused[0]!.reason).toBeInstanceOf(GovernanceConflict);
  expect(refused[0]!.reason.message).toBe('idempotency key reused');
  expect(f.applications()).toBe(1);
  await expectOneDecision(f.input, succeeded[0]!.value.decisionId);
});

test('a new decision key on the advanced generation still requires a fresh platform claim', async () => {
  const f = await fixture();
  const first = await f.store.decide(f.principal, f.input);
  await expect(
    f.store.decide(f.principal, {
      ...f.input,
      expectedGeneration: first.caseGeneration,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toThrow('claim the case before deciding');
  expect(f.applications()).toBe(1);
  await expectOneDecision(f.input, first.decisionId);
});

test('the original principal cannot replay after losing decision authority', async () => {
  const f = await fixture();
  const first = await f.store.decide(f.principal, f.input);
  await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [f.grantId]);
  await expect(f.store.decide(f.principal, f.input)).rejects.toBeInstanceOf(GovernanceDenied);
  expect(f.applications()).toBe(1);
  await expectOneDecision(f.input, first.decisionId);
});

test('overlapping retained decisions keep pending effects resumable without a new claim', async () => {
  const f = await fixture();
  f.overlapNextPair();
  const results = await Promise.all([
    f.store.decide(f.principal, f.input, true),
    f.store.decide(f.principal, f.input, true),
  ]);
  expect(outcome(results[0]!)).toEqual(outcome(results[1]!));
  expect(f.applications()).toBe(0);
  const resumed = await f.store.decide(f.principal, f.input);
  expect(resumed.decisionId).toBe(results[0]!.decisionId);
  expect(resumed.operation.status).toBe('completed');
  expect(f.applications()).toBe(1);
  await expectOneDecision(f.input, resumed.decisionId);
});
