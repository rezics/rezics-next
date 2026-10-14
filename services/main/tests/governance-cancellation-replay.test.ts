import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { expireFixtureAuthority, grantFixtureAuthority, reduceFixtureGrant } from '../src/modules/access/fixture-authority.ts';
import { AccountAssertionVerifier } from '../src/modules/account/verify-assertion.ts';
import { KnownEffectFailure } from '../src/modules/governance/effects.ts';
import { GLOBAL_CONTEXT, GovernanceStore, type DecisionInput, type DecisionResult } from '../src/modules/governance/store.ts';
import { SCREEN_POLICY } from '../src/modules/media-screen/policy.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { safetyCaseRoutes } from '../src/routes/safety-cases.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const issuer = 'https://account.cancellation.test';
const audience = 'rezics-main';
const scope = 'governance:platform';
const rule = { ref: 'urn:rule:cancellation', revision: '1', digest: 'a'.repeat(64) };
let cluster: PostgresCluster | undefined;
let pool: Pool;
let account: AccountAssertionVerifier;
let accountServer: ReturnType<typeof Bun.serve>;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
const assertions = new Map<string, { subject: string; active: boolean }>();
let legacy: Awaited<ReturnType<typeof fixture>>;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 8 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(root, 'access').filter(file => !file.endsWith('_governance_cancellation_replay.sql'))) {
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  signing = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(signing.publicKey), kid: 'cancellation', alg: 'RS256', use: 'sig' };
  // Only the external Account wire boundary is supplied here. JWT checking,
  // current introspection, route admission and all owner SQL execute normally.
  accountServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/jwks') return Response.json({ keys: [jwk] });
    const form = new URLSearchParams(await request.text());
    if (form.get('client_id') !== 'main' || form.get('client_secret') !== 'fixture-secret') {
      return new Response(null, { status: 401 });
    }
    const assertion = assertions.get(form.get('token') ?? '');
    return Response.json({ active: assertion?.active ?? false, iss: issuer, sub: assertion?.subject,
      aud: audience, scope: 'governance:decide', exp: Math.floor(Date.now() / 1000) + 300 });
  } });
  const base = `http://127.0.0.1:${accountServer.port}`;
  account = new AccountAssertionVerifier({ issuer, audience, jwksUrl: `${base}/jwks`,
    introspectUrl: `${base}/introspect`, clientId: 'main', clientSecret: 'fixture-secret' });
  legacy = await fixture({ partial: true });
  // Reproduce the old cancellation write before applying the additive migration.
  // The real owner created this decision, its effects and its confirmed receipt.
  await pool.query('UPDATE access.safety_decision_operation SET cancelled = true WHERE decision_id = $1',
    [legacy.decision.decisionId]);
  const migration = schemaFiles(root, 'access').find(file => file.endsWith('_governance_cancellation_replay.sql'))!;
  await pool.query(readFileSync(join(root, 'services/main/migrations/access', migration), 'utf8'));
}, 60_000);

afterAll(async () => {
  await accountServer?.stop(true);
  await pool?.end();
  cluster?.remove();
});

async function member() {
  const principalId = randomUUID(), subject = randomUUID(), actor = native();
  const principal = { issuer, subject };
  await pool.query('INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principalId, issuer, subject]);
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
  const authority = await grantFixtureAuthority(pool, { scope, requireDispatch: true,
    representations: [{ principalId, actor, action: 'governance.moderate', lifetime: 'infinity' }],
    grant: { actor, action: 'governance.moderate', lifetime: 'infinity' } });
  const token = await new SignJWT({ scope: 'governance:decide' })
    .setProtectedHeader({ alg: 'RS256', kid: 'cancellation' }).setIssuer(issuer).setAudience(audience)
    .setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(signing.privateKey);
  const assertion = { subject, active: true };
  assertions.set(token, assertion);
  return { principalId, principal, actor, token, assertion, grantId: authority.grantId };
}

async function fixture(options: { partial?: boolean; completed?: boolean; urgent?: boolean } = {},
  existingCaller?: Awaited<ReturnType<typeof member>>) {
  const caller = existingCaller ?? await member();
  const asset = randomUUID();
  const resource = options.urgent ? `https://rezics.com/id/${asset}` : native();
  const revision = native();
  let head = revision, now = new Date();
  const applications: string[] = [];
  const store = new GovernanceStore(pool, {
    capture: async (_principal, _actor, target) => ({ ...target, state: 'available',
      representation: 'Retained cancellation evidence.', revisionDigest: 'b'.repeat(64), provenance: {} }),
  }, { current: async () => head }, { current: async () => rule }, {
    participants: async () => [],
    apply: async (operationId, ordinal) => {
      applications.push(`${operationId}:${ordinal}`);
      if (options.partial && ordinal === 2) throw new KnownEffectFailure('owner-refused');
      return { receipt: `urn:receipt:${operationId}:${ordinal}` };
    },
  }, undefined, () => now);
  let evidenceGrant: string | undefined;
  if (options.urgent) {
    evidenceGrant = (await grantFixtureAuthority(pool, { scope, requireDispatch: true,
      representations: [{ principalId: caller.principalId, actor: caller.actor,
        action: 'governance.safety.evidence', lifetime: 'infinity' }],
      grant: { actor: caller.actor, action: 'governance.safety.evidence', lifetime: 'infinity' } })).grantId;
    await store.openScreeningCase({ job: randomUUID(), asset, source: randomUUID(), digest: 'c'.repeat(64),
      verdict: { clearance: 'held', reason: 'likely-explicit', evidence: { ...SCREEN_POLICY } } });
  }
  const target = { owner: options.urgent ? 'media' as const : 'graph' as const, resource,
    component: options.urgent ? 'record' as const : 'title' as const, revision, locator: null };
  const targets = [target, { ...target, resource: native() }];
  const reportInput = { kind: 'content_report' as const, actingSubject: caller.actor,
    authority: { kind: 'platform' as const, scopeId: scope }, context: GLOBAL_CONTEXT, target,
    disclosure: 'private' as const, reasonCode: 'spam', statement: 'Review retained evidence.',
    evidence: targets, idempotencyKey: randomUUID() };
  const report = await store.submitReport(caller.principal, reportInput);
  await store.safety.claim(caller.principal, caller.actor, report.caseId);
  const input: DecisionInput = { caseId: report.caseId, expectedGeneration: report.caseGeneration,
    actingSubject: caller.actor, outcome: 'restrict', targets: targets.map(target => ({ ...target,
      scopeKind: 'exact_revision', expectedHead: revision, effect: 'disclosure' })),
    rule, evidenceDigest: report.evidenceDigest, reversesDecisionId: null, answersStepId: null,
    rationale: null, disclosure: 'private', idempotencyKey: randomUUID(), reasons: {
      facts: 'Reviewed the retained evidence.', scope: 'Two exact revisions.', duration: 'Until reconsidered.',
      automation: options.urgent ?? false, contentLanguage: 'en', appealRoute: '/v1/public-reports/{caseId}/correspondence',
    } };
  const decision = await store.decide(caller.principal, input, !options.partial && !options.completed);
  const dependencies: Pick<MainWorkDependencies, 'account' | 'governance'> = { account, governance: { store } };
  const route = safetyCaseRoutes(dependencies as MainWorkDependencies);
  async function cancel(key: string, actor = caller.actor, member = caller,
    decisionId = decision.decisionId, header: string | null = key) {
    const response = await route.handle(new Request(`http://main.local/v1/safety-decisions/${decisionId}/cancellation`, {
      method: 'POST', headers: { authorization: `Bearer ${member.token}`, 'content-type': 'application/json',
        ...(header === null ? {} : { 'idempotency-key': header }) },
      body: JSON.stringify({ actingSubject: actor, idempotencyKey: key }),
    }));
    return { status: response.status, body: await response.json() };
  }
  return { caller, store, decision, input, cancel, applications, evidenceGrant,
    expireClaim() { now = new Date(now.getTime() + 31 * 60_000); },
    async advance() {
      head = native();
      await store.safety.claim(caller.principal, caller.actor, decision.caseId);
      const next = await store.decide(caller.principal, { ...input,
        expectedGeneration: decision.caseGeneration, idempotencyKey: randomUUID(),
        outcome: 'dismiss', targets: [] }, true);
      expect(next.caseId).toBe(decision.caseId);
      expect(BigInt(next.caseGeneration)).toBeGreaterThan(BigInt(decision.caseGeneration));
      const current = await store.readSafetyCase(caller.principal, caller.actor, decision.caseId);
      expect(current.decision?.decisionId).toBe(next.decisionId);
    },
    async reconsider() {
      head = native();
      await store.safety.claim(caller.principal, caller.actor, decision.caseId);
      return store.decide(caller.principal, { ...input,
        expectedGeneration: decision.caseGeneration, idempotencyKey: randomUUID(),
        targets: input.targets.map(target => ({ ...target, expectedHead: head })) });
    },
  };
}

async function snapshot(decision: DecisionResult) {
  const values = [decision.decisionId];
  return {
    decision: (await pool.query('SELECT to_jsonb(d) AS row FROM access.moderation_decision d WHERE id = $1', values)).rows,
    targets: (await pool.query('SELECT to_jsonb(t) AS row FROM access.moderation_decision_target t WHERE decision_id = $1 ORDER BY ordinal', values)).rows,
    effects: (await pool.query('SELECT to_jsonb(e) AS row FROM access.safety_decision_effect e WHERE decision_id = $1 ORDER BY ordinal', values)).rows,
    operation: (await pool.query('SELECT to_jsonb(o) AS row FROM access.safety_decision_operation o WHERE decision_id = $1', values)).rows,
    enforcement: (await pool.query('SELECT to_jsonb(e) AS row FROM access.governance_enforcement e WHERE decision_id = $1 ORDER BY resource', values)).rows,
    outbox: (await pool.query('SELECT to_jsonb(o) AS row FROM access.outbox o WHERE moderation_decision_id = $1 ORDER BY id', values)).rows,
    case: (await pool.query('SELECT to_jsonb(c) AS row FROM access.governance_case c WHERE id = $1', [decision.caseId])).rows,
  };
}

// Compare complete answers, including enforcement, rather than inferring replay
// from the flag or from unchanged effect receipts alone.
test('cancellation preserves a partial answer across both keys and source/case head changes', async () => {
  const f = await fixture({ partial: true });
  expect(f.decision.operation.status).toBe('partial');
  expect(f.decision.operation.items[0]).toMatchObject({ state: 'confirmed', receipt: expect.any(String) });
  const before = await snapshot(f.decision);
  const key = randomUUID(), otherKey = randomUUID();
  const first = await f.cancel(key);
  expect(first.status).toBe(200);
  expect(first.body).toEqual({ profile: 'moderation-decision-v1', ...f.decision, replayed: true,
    operation: { ...f.decision.operation, status: 'cancelled', continuation: null } });
  const { profile: _profile, ...ownerAnswer } = first.body;
  const saved = await snapshot(f.decision);
  expect(saved).toEqual({ ...before, operation: [{ row: { ...before.operation[0]!.row, cancelled: true,
    cancellation_principal_id: f.caller.principalId, cancellation_key: key,
    cancellation_request_digest: expect.stringMatching(/^[0-9a-f]{64}$/), cancellation_result: ownerAnswer } }] });
  expect(await f.cancel(key)).toEqual(first);
  expect(await f.cancel(otherKey)).toEqual(first);
  expect(await f.store.cancelDecision(f.caller.principal, f.caller.actor, f.decision.decisionId, key))
    .toEqual(ownerAnswer);
  expect(await snapshot(f.decision)).toEqual(saved);
  await f.advance();
  const advanced = await snapshot(f.decision);
  expect(await f.cancel(key)).toEqual(first);
  expect(await f.cancel(otherKey)).toEqual(first);
  expect(await snapshot(f.decision)).toEqual(advanced);
  const resumed = await f.store.resumeDecision(f.caller.principal, f.caller.actor, f.decision.decisionId);
  expect(resumed.operation).toEqual(first.body.operation);
  expect(f.applications).toHaveLength(2);
});

test('overlapping first cancellations with the same or another key return one resource answer', async () => {
  for (const sameKey of [true, false]) {
    const f = await fixture();
    const key = randomUUID();
    // Hold the real case lock until both HTTP requests are waiting for it.
    const lock = await pool.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM access.governance_case WHERE id = $1 FOR UPDATE', [f.decision.caseId]);
    let responses: Awaited<ReturnType<typeof f.cancel>>[];
    try {
      const pending = Promise.all([f.cancel(key), f.cancel(sameKey ? key : randomUUID())]);
      const deadline = Date.now() + 1500;
      let waiting = 0;
      while (waiting < 2 && Date.now() < deadline) {
        await lock.query('SELECT pg_stat_clear_snapshot()');
        waiting = Number((await lock.query<{ count: string }>(`SELECT count(*)::text FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%FOR UPDATE OF c%'`)).rows[0]!.count);
        if (waiting < 2) await Bun.sleep(5);
      }
      expect(waiting).toBe(2);
      await lock.query('COMMIT');
      responses = await pending;
    } finally { await lock.query('ROLLBACK'); lock.release(); }
    expect(responses[0]!.status).toBe(200);
    expect(responses[0]).toEqual(responses[1]);
    expect(responses[0]!.body.operation).toMatchObject({ status: 'cancelled', continuation: null });
    expect(await f.cancel(key)).toEqual(responses[0]!);
    expect(f.applications).toHaveLength(0);
  }
});

test('overlapping use of one principal key for different decisions cancels only its winning intent', async () => {
  const first = await fixture(), second = await fixture({}, first.caller), key = randomUUID();
  const results = await Promise.all([first.cancel(key), second.cancel(key)]);
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  const winner = results.find(result => result.status === 200)!;
  const refused = results.find(result => result.status === 409)!;
  expect(refused.body).toMatchObject({ code: 'idempotency_conflict', title: 'idempotency key reused' });
  const before = await snapshot(first.decision), secondBefore = await snapshot(second.decision);
  expect(await first.cancel(key)).toEqual(results[0]!);
  expect(await second.cancel(key)).toEqual(results[1]!);
  const bindings = (await pool.query(`SELECT decision_id FROM access.safety_decision_operation
    WHERE cancellation_principal_id = $1 AND cancellation_key = $2`, [first.caller.principalId, key])).rows;
  expect(bindings).toEqual([{ decision_id: winner.body.decisionId }]);
  expect(await snapshot(first.decision)).toEqual(before);
  expect(await snapshot(second.decision)).toEqual(secondBefore);
  expect(first.applications).toHaveLength(0);
  expect(second.applications).toHaveLength(0);
});

test('a retained key binds the currently authorized caller actingSubject through the ordinary conflict mapping', async () => {
  const f = await fixture(), successor = await member(), key = randomUUID();
  const first = await f.cancel(key);
  expect(first.status).toBe(200);
  await grantFixtureAuthority(pool, { scope, requireDispatch: true,
    representations: [{ principalId: f.caller.principalId, actor: successor.actor,
      action: 'governance.moderate', lifetime: 'infinity' }],
    grant: { actor: successor.actor, action: 'governance.moderate', lifetime: 'infinity' } });
  f.expireClaim();
  await f.store.safety.claim(f.caller.principal, successor.actor, f.decision.caseId);
  const before = await snapshot(f.decision);
  const changed = await f.cancel(key, successor.actor);
  expect(changed.status).toBe(409);
  expect(changed.body).toMatchObject({ code: 'idempotency_conflict', title: 'idempotency key reused' });
  expect(await f.cancel(randomUUID(), successor.actor)).toEqual(first);
  expect(await snapshot(f.decision)).toEqual(before);
  expect(f.applications).toHaveLength(0);
});

test('a changed actingSubject is ordinarily denied until currently represented and claimed, then replays the resource', async () => {
  const f = await fixture();
  const key = randomUUID(), first = await f.cancel(key);
  const successor = await member();
  const saved = await snapshot(f.decision);
  const unrepresented = await f.cancel(key, successor.actor);
  expect(unrepresented.status).toBe(403);
  expect(unrepresented.body.code).toBe('governance_denied');
  const unclaimed = await f.cancel(key, successor.actor, successor);
  expect(unclaimed.status).toBe(403);
  expect(unclaimed.body.title).toBe('claim the case before cancelling');
  expect(await snapshot(f.decision)).toEqual(saved);
  f.expireClaim();
  await f.store.safety.claim(successor.principal, successor.actor, f.decision.caseId);
  const transferred = await snapshot(f.decision);
  expect(await f.cancel(key, successor.actor, successor)).toEqual(first);
  expect(await f.cancel(randomUUID(), successor.actor, successor)).toEqual(first);
  expect((await f.cancel(key)).status).toBe(403);
  expect(await snapshot(f.decision)).toEqual(transferred);
  expect(f.applications).toHaveLength(0);
});

for (const loss of ['account', 'representation', 'grant-expired', 'grant-revoked', 'claim', 'urgent-evidence'] as const) {
  test(`current ${loss} authority refuses both replay keys like a fresh cancellation without disclosure or writes`, async () => {
    const f = await fixture({ urgent: loss === 'urgent-evidence' });
    const key = randomUUID(), otherKey = randomUUID();
    const first = await f.cancel(key);
    expect(first.status).toBe(200);
    expect(await f.cancel(otherKey)).toEqual(first);
    // A second real decision resource has never received a cancellation.
    await f.store.safety.claim(f.caller.principal, f.caller.actor, f.decision.caseId);
    const fresh = await f.store.decide(f.caller.principal, { ...f.input,
      expectedGeneration: f.decision.caseGeneration, idempotencyKey: randomUUID() }, true);
    expect(fresh.operation.status).toBe('accepted');
    expect(await f.cancel(key)).toEqual(first);
    if (loss === 'account') f.caller.assertion.active = false;
    else if (loss === 'representation') await expireFixtureAuthority(pool, f.caller.actor);
    else if (loss === 'grant-expired') await reduceFixtureGrant(pool, f.caller.grantId, { validUntil: new Date(0) });
    else if (loss === 'grant-revoked') await reduceFixtureGrant(pool, f.caller.grantId, { active: false });
    else if (loss === 'urgent-evidence') await reduceFixtureGrant(pool, f.evidenceGrant!, { active: false });
    else f.expireClaim();
    const saved = await snapshot(f.decision), freshSaved = await snapshot(fresh);
    const denied = await f.cancel(key);
    expect(denied.status).toBe(loss === 'account' ? 401 : 403);
    expect(denied.body).not.toHaveProperty('decisionId');
    expect(denied.body).not.toHaveProperty('operation');
    expect(denied.body).not.toHaveProperty('enforcement');
    expect(await f.cancel(otherKey)).toEqual(denied);
    expect(await f.cancel(randomUUID(), f.caller.actor, f.caller, fresh.decisionId)).toEqual(denied);
    expect(await snapshot(f.decision)).toEqual(saved);
    expect(await snapshot(fresh)).toEqual(freshSaved);
    expect(f.applications).toHaveLength(0);
  });
}

test('cancellation retains its first answer after a later lawful decision advances the enforcement fence', async () => {
  const f = await fixture({ partial: true });
  const key = randomUUID(), otherKey = randomUUID();
  const first = await f.cancel(key);
  expect(first.status).toBe(200);
  expect(first.body.enforcement[0].fenceEpoch).toBe('1');
  const next = await f.reconsider();
  expect(next.decisionId).not.toBe(f.decision.decisionId);
  expect(BigInt(next.caseGeneration)).toBeGreaterThan(BigInt(f.decision.caseGeneration));
  expect(next.enforcement[0]!.fenceEpoch).toBe('2');
  const before = await snapshot(f.decision), nextBefore = await snapshot(next);
  const sameKey = await f.cancel(key), anotherKey = await f.cancel(otherKey);
  expect(sameKey.body.operation).toEqual(first.body.operation);
  expect(anotherKey.body.operation).toEqual(first.body.operation);
  expect(await snapshot(f.decision)).toEqual(before);
  expect(await snapshot(next)).toEqual(nextBefore);
  expect(f.applications).toHaveLength(4);
  expect(sameKey).toEqual(first);
  expect(anotherKey).toEqual(first);
});

test('a migrated cancellation retains its first post-upgrade answer and refuses changed-decision reuse', async () => {
  const f = legacy, key = randomUUID();
  const before = await snapshot(f.decision);
  expect(before.operation[0]!.row).toMatchObject({ cancelled: true, cancellation_principal_id: null,
    cancellation_key: null, cancellation_request_digest: null, cancellation_result: null });
  const first = await f.cancel(key);
  expect(first.status).toBe(200);
  expect(first.body).toEqual({ profile: 'moderation-decision-v1', ...f.decision, replayed: true,
    operation: { ...f.decision.operation, status: 'cancelled', continuation: null } });
  expect(first.body.enforcement[0].fenceEpoch).toBe('1');
  expect(await f.cancel(key)).toEqual(first);
  const { profile: _profile, ...ownerAnswer } = first.body;
  const bound = await snapshot(f.decision);
  expect(bound).toEqual({ ...before, operation: [{ row: { ...before.operation[0]!.row,
    cancellation_principal_id: f.caller.principalId, cancellation_key: key,
    cancellation_request_digest: expect.stringMatching(/^[0-9a-f]{64}$/), cancellation_result: ownerAnswer } }] });
  const next = await f.reconsider();
  expect(next.enforcement[0]!.fenceEpoch).toBe('2');
  const advanced = await snapshot(f.decision), nextBefore = await snapshot(next);
  expect(await f.cancel(key)).toEqual(first);
  const refused = await f.cancel(key, f.caller.actor, f.caller, next.decisionId);
  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ code: 'idempotency_conflict', title: 'idempotency key reused' });
  expect(await snapshot(f.decision)).toEqual(advanced);
  expect(await snapshot(next)).toEqual(nextBefore);
  await reduceFixtureGrant(pool, f.caller.grantId, { active: false });
  const denied = await f.cancel(key);
  expect(denied.status).toBe(403);
  expect(denied.body.code).toBe('governance_denied');
  expect(denied.body).not.toHaveProperty('operation');
  expect(await f.cancel(randomUUID())).toEqual(denied);
  expect(await f.cancel(randomUUID(), f.caller.actor, f.caller, next.decisionId)).toEqual(denied);
  expect(await snapshot(f.decision)).toEqual(advanced);
  expect(await snapshot(next)).toEqual(nextBefore);
  expect(f.applications).toHaveLength(4);
});

test('completed cancellation keeps the existing GovernanceConflict HTTP mapping and all receipts', async () => {
  const f = await fixture({ completed: true });
  expect(f.decision.operation.status).toBe('completed');
  const saved = await snapshot(f.decision), key = randomUUID();
  const refused = await f.cancel(key);
  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ code: 'idempotency_conflict',
    title: 'completed decisions require a new reversal, not cancellation' });
  expect(await f.cancel(key)).toEqual(refused);
  expect(await f.cancel(randomUUID())).toEqual(refused);
  expect(await snapshot(f.decision)).toEqual(saved);
  expect(f.applications).toHaveLength(2);
});

test('the public cancellation key remains required and must match the body', async () => {
  const f = await fixture(), key = randomUUID(), saved = await snapshot(f.decision);
  for (const header of [null, randomUUID()]) {
    const refused = await f.cancel(key, f.caller.actor, f.caller, f.decision.decisionId, header);
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('invalid_idempotency_key');
  }
  expect(await snapshot(f.decision)).toEqual(saved);
});
