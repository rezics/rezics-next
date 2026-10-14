import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { KnownEffectFailure, type EffectPlan } from '../src/modules/governance/effects.ts';
import { DECIDE_ACTION, GLOBAL_CONTEXT, GovernanceDenied, GovernanceStale, GovernanceStore, GovernanceUnavailable,
  type DecisionInput, type DecisionResult, type DecisionTargetInput, type ReportInput,
} from '../src/modules/governance/store.ts';
import { recordCounterNotice } from '../src/modules/rights/counter-notice.ts';
import { SPACE_REALM_PROFILE } from '../src/modules/space/create.ts';
import { RULE_PUBLISH_ACTION } from '../src/modules/governance/rules.ts';
import { GRAPHS, RV, hash, iri } from '../src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const rule = { ref: 'urn:rule:realm-restoration', revision: '1', digest: 'a'.repeat(64) };
let cluster: PostgresCluster | undefined;
let pool: Pool;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 8 });
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

afterAll(async () => { await pool?.end(); cluster?.remove(); });

async function fixture(options: {
  kind?: ReportInput['kind']; process?: 'dmca_512' | 'ordinary_dispute';
  realm?: string; space?: string; head?: string; component?: 'record' | 'title';
  legacyLocal?: boolean;
} = {}) {
  const kind = options.kind ?? 'content_report';
  const realm = options.realm ?? native(), space = options.space ?? native();
  let head = options.head ?? native();
  const evidenceHead = head;
  const alternate = native();
  const zone = native(), reply = randomUUID();
  const principalId = randomUUID();
  const principal: VerifiedPrincipal = { issuer: 'https://account.realm-restoration.test', subject: randomUUID() };
  const actor = native();
  await pool.query('INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principalId, principal.issuer, principal.subject]);
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
  const action = DECIDE_ACTION[kind];
  const scope = options.legacyLocal ? `governance:resource:${realm}` : 'governance:platform';
  await grantFixtureAuthority(pool, { scope, requireDispatch: true,
    representations: [{ principalId, actor, action, lifetime: 'infinity' }],
    grant: { actor, action, lifetime: 'infinity' } });
  let now = new Date('2026-10-01T14:37:12Z');
  let rejectOwner = false, loseOwnerAck = false, loseAccessAck = false;
  let persistPlan: ((plan: EffectPlan) => EffectPlan) | undefined;
  let scheduledJurisdiction: { authority_kind: string; authority_scope_id: string; context: string } | undefined;
  let scheduledBasisReads = 0;
  let rendezvous: (() => Promise<void>) | undefined;
  let ownerCalls = 0;
  const ownerReceipts = new Map<string, string>();
  const seenPlans: EffectPlan[] = [];
  // Only the acknowledgement boundary is faulted; all case, source, fence and
  // eligibility reads and writes still execute against real migrated Access.
  const faultPool = new Proxy(pool, { get(target, property) {
    if (property === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, member) {
        if (member === 'query') return async (...args: unknown[]) => {
          if (persistPlan && typeof args[0] === 'string'
            && args[0].includes('INSERT INTO access.safety_decision_effect') && Array.isArray(args[1])) {
            // Historical plans are immutable after insert. Fault the old
            // serializer boundary instead of disabling that database guard.
            const values = [...args[1]];
            values[2] = persistPlan(values[2] as EffectPlan);
            args[1] = values;
            persistPlan = undefined;
          }
          if (loseAccessAck && typeof args[0] === 'string'
            && args[0].includes("UPDATE access.safety_decision_effect SET state = 'confirmed'")) {
            loseAccessAck = false;
            throw new Error('Access acknowledgement lost after owner commit');
          }
          const result = await Reflect.apply(connection.query, connection, args);
          if (scheduledJurisdiction && typeof args[0] === 'string'
            && args[0].includes('FROM access.rights_counter_notice j JOIN access.governance_case c')) {
            scheduledBasisReads++;
            return { ...result, rows: result.rows.map((row: Record<string, unknown>) => ({ ...row, ...scheduledJurisdiction })) };
          }
          return result;
        };
        const value = Reflect.get(connection, member);
        return typeof value === 'function' ? value.bind(connection) : value;
      } });
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const store = new GovernanceStore(faultPool, {
    capture: async (_principal, _actor, target) => ({ ...target, state: 'available',
      representation: target.revision, revisionDigest: 'b'.repeat(64), provenance: {} }),
  }, {
    current: async () => head,
    realmBasis: async target => !options.legacyLocal && target.owner === 'graph' && target.component === 'record' && target.resource === realm
      ? { realm: target.resource, space, head, profile: SPACE_REALM_PROFILE,
        profileId: 'space-realm-v3', legacy: false } : null,
  }, { current: async (_ref, _scope, client) => {
    if (!client && rendezvous) await rendezvous();
    return rule;
  } }, {
    participants: async () => [],
    apply: async (operationId, ordinal, _target, plan) => {
      ownerCalls++;
      seenPlans.push(plan ?? {});
      if (rejectOwner) throw new KnownEffectFailure('realm-owner-rejected');
      const key = `${operationId}:${ordinal}`;
      const receipt = ownerReceipts.get(key) ?? `urn:receipt:${key}`;
      ownerReceipts.set(key, receipt);
      if (loseOwnerAck) { loseOwnerAck = false; throw new Error('Owner response lost after commit'); }
      return { receipt };
    },
  }, undefined, () => now);
  const component = options.component ?? 'record';
  const evidence = { owner: 'graph' as const, resource: realm, component, locator: null, revision: evidenceHead };
  const report = await store.submitReport(principal, {
    kind, actingSubject: actor, authority: { kind: options.legacyLocal ? 'resource_owner' : 'platform', scopeId: scope },
    context: GLOBAL_CONTEXT, target: evidence, disclosure: 'private', reasonCode: 'spam',
    statement: 'Review this retained Realm record.',
    // Alternative grains are retained so tuple-change refusals exercise source
    // identity rather than relying on absence from the report's evidence.
    evidence: [evidence, { ...evidence, component: 'title' },
      { ...evidence, locator: 'alias' }, { ...evidence, revision: alternate },
      { ...evidence, resource: alternate }, { ...evidence, owner: 'content' },
      { ...evidence, resource: zone }, { ...evidence, owner: 'content', resource: reply, component: 'body' }],
    idempotencyKey: randomUUID(),
    ...(kind === 'rights_complaint' ? { complaint: {
      process: options.process ?? 'ordinary_dispute', claimantKind: 'rights_holder' as const,
      claimantName: 'Claimant', claimantContact: null, claimedWork: realm, claimedRight: 'copyright',
      noticeDigest: 'c'.repeat(64), noticeReceivedAt: now.toISOString(),
    } } : {}),
  });
  const input: DecisionInput = {
    caseId: report.caseId, expectedGeneration: report.caseGeneration, actingSubject: actor,
    outcome: kind === 'rights_complaint' ? 'final_restrict' : 'restrict',
    targets: [{ ...evidence, revision: null, scopeKind: 'component', expectedHead: head, effect: 'disclosure' }],
    rule, evidenceDigest: report.evidenceDigest, reversesDecisionId: null, answersStepId: null,
    rationale: null, disclosure: 'private', idempotencyKey: randomUUID(), reasons: {
      facts: 'The retained record has been reviewed.', scope: 'The whole Realm record.',
      duration: 'Until platform reconsideration.', automation: false, contentLanguage: 'en',
      appealRoute: '/v1/public-reports/{caseId}/correspondence',
    },
  };
  async function claim() { await store.safety.claim(principal, actor, report.caseId); }
  if (!options.legacyLocal) await claim();
  return {
    store, principal, principalId, actor, realm, space, zone, reply, evidenceHead, alternate, report, input, claim,
    setHead(value: string) { head = value; }, setClock(value: Date) { now = value; },
    rejectOwner() { rejectOwner = true; }, loseOwnerAck() { loseOwnerAck = true; },
    loseAccessAck() { loseAccessAck = true; }, ownerCalls: () => ownerCalls,
    committedOwners: () => ownerReceipts.size, seenPlans,
    readScheduledJurisdiction(basis: NonNullable<typeof scheduledJurisdiction>) { scheduledJurisdiction = basis; },
    scheduledBasisReads: () => scheduledBasisReads,
    omitPersistedSource() { persistPlan = plan => {
      const { restorationRestrictionId: _source, ...old } = plan;
      return old;
    }; },
    replacePersistedSource(id: string) { persistPlan = plan => ({ ...plan, restorationRestrictionId: id }); },
    overlapNextPair() {
      let arrived = 0;
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      rendezvous = async () => {
        if (++arrived === 2) { rendezvous = undefined; release(); }
        await ready;
      };
    },
    async release(restriction: DecisionResult, outcome: 'restore' | 'reverse' = 'restore', stepId: string | null = null) {
      await claim();
      return { ...input, expectedGeneration: restriction.caseGeneration, outcome,
        reversesDecisionId: outcome === 'reverse' ? restriction.decisionId : null,
        answersStepId: stepId, targets: [{ ...input.targets[0]!, expectedHead: head }],
        idempotencyKey: randomUUID() } satisfies DecisionInput;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function closureFence(f: Fixture) {
  return (await pool.query<{ decision_id: string; state: string; fence_epoch: string }>(
    `SELECT decision_id,state,fence_epoch::text FROM access.governance_enforcement
     WHERE resource = $1 AND component = 'record' AND revision IS NULL AND effect = 'disclosure'`,
    [f.realm],
  )).rows;
}

async function assertRestricted(f: Fixture, restriction: DecisionResult) {
  expect(await closureFence(f)).toEqual([{ decision_id: restriction.decisionId,
    state: 'restricted', fence_epoch: '1' }]);
}

for (const outcome of ['restore', 'reverse'] as const) {
  test(`${outcome} persists the original closure source and CASes the current Realm head`, async () => {
    const f = await fixture();
    const restricted = await f.store.decide(f.principal, f.input);
    f.setHead(native());
    const release = await f.release(restricted, outcome);
    const restored = await f.store.decide(f.principal, release);
    expect(restored.operation.status).toBe('completed');
    expect(await closureFence(f)).toEqual([{ decision_id: restored.decisionId, state: 'released', fence_epoch: '2' }]);
    const retained = (await pool.query<{ plan: EffectPlan; expected_head: string }>(
      `SELECT e.plan,t.expected_head FROM access.safety_decision_effect e
       JOIN access.moderation_decision_target t USING (decision_id,ordinal) WHERE e.decision_id = $1`,
      [restored.decisionId],
    )).rows[0]!;
    expect(retained.plan).toMatchObject({ restorationRestrictionId: restricted.decisionId,
      realm: { realm: f.realm, space: f.space } });
    expect(retained.expected_head).toBe(release.targets[0]!.expectedHead!);
    expect(retained.expected_head).not.toBe(f.evidenceHead);
    expect(f.seenPlans.at(-1)?.restorationRestrictionId).toBe(restricted.decisionId);
  });

  test(`${outcome} cannot release a fence superseded after acceptance`, async () => {
    const f = await fixture();
    const original = await f.store.decide(f.principal, f.input);
    const accepted = await f.store.decide(f.principal, await f.release(original, outcome), true);
    const peer = await fixture({ kind: 'rights_complaint', realm: f.realm, space: f.space, head: f.evidenceHead });
    const superseding = await peer.store.decide(peer.principal, peer.input);
    expect(superseding.operation.status).toBe('completed');
    const resumed = await f.store.resumeDecision(f.principal, f.actor, accepted.decisionId);
    expect(resumed.operation.status).toBe('partial');
    expect(resumed.operation.items[0]?.state).toBe('failed');
    expect(f.ownerCalls()).toBe(1);
    expect(await closureFence(f)).toEqual([{ decision_id: superseding.decisionId, state: 'restricted', fence_epoch: '2' }]);
  });
}

for (const outcome of ['restore', 'reverse'] as const) {
  for (const stage of ['acceptance', 'dispatch'] as const) {
    test(`${outcome} refuses a distinct parallel Realm disclosure fence at ${stage} while preserving its original source`, async () => {
      const f = await fixture();
      const original = await f.store.decide(f.principal, f.input);
      const release = await f.release(original, outcome);
      const accepted = stage === 'dispatch' ? await f.store.decide(f.principal, release, true) : null;
      // A retained pre-upgrade local restriction occupies a different scope
      // key. It must neither supersede the source nor permit its release.
      const peer = await fixture({ realm: f.realm, space: f.space, head: f.evidenceHead, legacyLocal: true });
      const parallel = await peer.store.decide(peer.principal, peer.input);
      expect(parallel.operation.status).toBe('completed');
      const before = (await pool.query(`SELECT id,decision_id,authority_scope_id,state,fence_epoch::text
        FROM access.governance_enforcement WHERE resource=$1 ORDER BY authority_scope_id`, [f.realm])).rows;
      expect(before).toHaveLength(2);
      expect(before.map(row => row.decision_id)).toEqual(expect.arrayContaining([original.decisionId, parallel.decisionId]));
      expect(before.every(row => row.state === 'restricted' && row.fence_epoch === '1')).toBe(true);
      if (accepted) {
        const resumed = await f.store.resumeDecision(f.principal, f.actor, accepted.decisionId);
        expect(resumed.operation.status).toBe('partial');
        expect(resumed.operation.items[0]).toMatchObject({ state: 'failed', receipt: null });
      } else {
        await expect(f.store.decide(f.principal, release)).rejects.toBeInstanceOf(GovernanceStale);
      }
      expect((await pool.query(`SELECT id,decision_id,authority_scope_id,state,fence_epoch::text
        FROM access.governance_enforcement WHERE resource=$1 ORDER BY authority_scope_id`, [f.realm])).rows).toEqual(before);
      expect(f.ownerCalls()).toBe(1);
    });
  }
}

const changedTuple: Array<{ name: string; change: (f: Fixture) => Partial<DecisionTargetInput> }> = [
  { name: 'owner', change: () => ({ owner: 'content' }) },
  { name: 'resource', change: f => ({ resource: f.alternate }) },
  { name: 'component', change: () => ({ component: 'title' }) },
  { name: 'locator', change: () => ({ locator: 'alias' }) },
  { name: 'scope and revision', change: f => ({ scopeKind: 'exact_revision', revision: f.evidenceHead }) },
  { name: 'revision', change: f => ({ scopeKind: 'exact_revision', revision: f.alternate }) },
  { name: 'effect', change: () => ({ effect: 'search' }) },
];
for (const outcome of ['restore', 'reverse'] as const) {
  test(`${outcome} refuses every changed original target tuple before owner dispatch`, async () => {
    const f = await fixture();
    const original = await f.store.decide(f.principal, f.input);
    for (const mutation of changedTuple) {
      const release = await f.release(original, outcome);
      await expect(f.store.decide(f.principal, { ...release,
        targets: [{ ...release.targets[0]!, ...mutation.change(f) }],
      })).rejects.toThrow();
      await assertRestricted(f, original);
      expect(f.ownerCalls()).toBe(1);
    }
    expect((await pool.query('SELECT 1 FROM access.moderation_decision WHERE case_id = $1',
      [f.report.caseId])).rowCount).toBe(1);
  });
}

test('concurrent same-key Realm releases replay one decision, owner receipt and fence increment', async () => {
  const f = await fixture();
  const original = await f.store.decide(f.principal, f.input);
  const release = await f.release(original);
  f.overlapNextPair();
  const results = await Promise.all([f.store.decide(f.principal, release), f.store.decide(f.principal, release)]);
  expect(results[0]!.decisionId).toBe(results[1]!.decisionId);
  expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
  expect(results.every(result => result.operation.status === 'completed')).toBe(true);
  expect(f.committedOwners()).toBe(2);
  expect(await closureFence(f)).toEqual([{ decision_id: results[0]!.decisionId, state: 'released', fence_epoch: '2' }]);
  expect((await pool.query('SELECT 1 FROM access.moderation_decision WHERE case_id = $1',
    [f.report.caseId])).rowCount).toBe(2);
});

for (const fault of ['loseOwnerAck', 'loseAccessAck'] as const) {
  test(`${fault}: an uncertain Realm release retains the closure until deterministic receipt replay`, async () => {
    const f = await fixture();
    const original = await f.store.decide(f.principal, f.input);
    const release = await f.release(original);
    f[fault]();
    const uncertain = await f.store.decide(f.principal, release);
    expect(uncertain.operation.status).toBe('partial');
    expect(uncertain.operation.items[0]?.state).toBe('uncertain');
    await assertRestricted(f, original);
    expect(f.committedOwners()).toBe(2);
    const retry = await f.store.decide(f.principal, release);
    expect(retry.replayed).toBe(true);
    expect(retry.decisionId).toBe(uncertain.decisionId);
    expect(retry.operation.status).toBe('completed');
    expect(f.committedOwners()).toBe(2);
    expect(f.ownerCalls()).toBe(3);
    expect(await closureFence(f)).toEqual([{ decision_id: retry.decisionId, state: 'released', fence_epoch: '2' }]);
    expect((await pool.query('SELECT 1 FROM access.outbox WHERE moderation_decision_id = $1',
      [retry.decisionId])).rowCount).toBe(1);
  });
}

test('known owner rejection leaves the original Realm fence restricted without a release receipt', async () => {
  const f = await fixture();
  const original = await f.store.decide(f.principal, f.input);
  f.rejectOwner();
  const failed = await f.store.decide(f.principal, await f.release(original));
  expect(failed.operation.status).toBe('partial');
  expect(failed.operation.items[0]).toMatchObject({ state: 'failed', receipt: null, error: 'realm-owner-rejected' });
  await assertRestricted(f, original);
  expect(f.committedOwners()).toBe(1);
});

test('an old Realm release without its saved source fails closed and needs a newly reviewed decision', async () => {
  const f = await fixture();
  const original = await f.store.decide(f.principal, f.input);
  f.omitPersistedSource();
  const old = await f.store.decide(f.principal, await f.release(original), true);
  await expect(f.store.resumeDecision(f.principal, f.actor, old.decisionId))
    .rejects.toBeInstanceOf(GovernanceUnavailable);
  await assertRestricted(f, original);
  expect(f.ownerCalls()).toBe(1);
  const cancelled = await f.store.cancelDecision(f.principal, f.actor, old.decisionId, randomUUID());
  expect(cancelled.operation.status).toBe('cancelled');
  const reviewed = await f.release(original);
  const restored = await f.store.decide(f.principal, { ...reviewed,
    expectedGeneration: old.caseGeneration });
  expect(restored.operation.status).toBe('completed');
  expect(f.seenPlans.at(-1)?.restorationRestrictionId).toBe(original.decisionId);
  expect(await closureFence(f)).toEqual([{ decision_id: restored.decisionId, state: 'released', fence_epoch: '2' }]);
});

for (const outcome of ['restore', 'reverse'] as const) {
  test(`${outcome} refuses a retained source inconsistent with its recorded step or reverse reference`, async () => {
    const f = await fixture();
    const original = await f.store.decide(f.principal, f.input);
    const step = await f.store.recordStep(f.principal, { caseId: f.report.caseId,
      decisionId: original.decisionId, actingSubject: f.actor, process: 'platform_appeal', step: 'appeal',
      partySubject: null, statement: 'Review the original closure.', documentDigest: null,
      occurredAt: '2026-10-01T14:37:12Z', dueAt: null, idempotencyKey: randomUUID() });
    f.replacePersistedSource(randomUUID());
    const accepted = await f.store.decide(f.principal,
      await f.release(original, outcome, outcome === 'restore' ? step.stepId : null), true);
    const resumed = await f.store.resumeDecision(f.principal, f.actor, accepted.decisionId);
    expect(resumed.operation.status).toBe('partial');
    expect(resumed.operation.items[0]?.state).toBe('failed');
    await assertRestricted(f, original);
    expect(f.ownerCalls()).toBe(1);
  });
}

test('whole-Realm release preserves exact-revision, search, publication, title, Zone and reply restrictions', async () => {
  const f = await fixture({ kind: 'rights_complaint' });
  const original = await f.store.decide(f.principal, f.input);
  const peer = await fixture({ realm: f.realm, space: f.space, head: f.evidenceHead });
  const narrow = await peer.store.decide(peer.principal, { ...peer.input,
    targets: [{ ...peer.input.targets[0]!, effect: 'search' },
      { ...peer.input.targets[0]!, effect: 'publication' },
      { ...peer.input.targets[0]!, component: 'title' },
      { ...peer.input.targets[0]!, scopeKind: 'exact_revision', revision: peer.evidenceHead },
      { ...peer.input.targets[0]!, resource: peer.zone },
      { ...peer.input.targets[0]!, owner: 'content', resource: peer.reply, component: 'body' }],
  });
  expect(narrow.operation.status).toBe('completed');
  // Ordinary disputes still require a recorded process step for restoration.
  const step = await f.store.recordStep(f.principal, { caseId: f.report.caseId,
    decisionId: original.decisionId, actingSubject: f.actor, process: 'ordinary_dispute',
    step: 'appeal', partySubject: null, statement: 'Review the original closure.',
    documentDigest: null, occurredAt: '2026-10-01T14:37:12Z', dueAt: null, idempotencyKey: randomUUID() });
  const restored = await f.store.decide(f.principal, await f.release(original, 'restore', step.stepId));
  expect(restored.operation.status).toBe('completed');
  const independent = (await pool.query(`SELECT resource,component,effect,revision,state
    FROM access.governance_enforcement WHERE decision_id = $1`, [narrow.decisionId])).rows;
  expect(independent).toHaveLength(6);
  expect(independent.every(row => row.state === 'restricted')).toBe(true);
  expect(independent).toEqual(expect.arrayContaining([
    { resource: f.realm, component: 'record', effect: 'publication', revision: null, state: 'restricted' },
    { resource: f.realm, component: 'record', effect: 'search', revision: null, state: 'restricted' },
    { resource: f.realm, component: 'title', effect: 'disclosure', revision: null, state: 'restricted' },
    { resource: f.realm, component: 'record', effect: 'disclosure', revision: f.evidenceHead, state: 'restricted' },
    { resource: peer.zone, component: 'record', effect: 'disclosure', revision: null, state: 'restricted' },
    { resource: peer.reply, component: 'body', effect: 'disclosure', revision: null, state: 'restricted' },
  ]));
});

async function counterNotice(f: Fixture, restriction: DecisionResult, delivered = true,
  reportId = f.report.reportId, receivedAt = new Date('2026-10-01T14:37:12Z')) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM access.governance_case WHERE id = $1 FOR UPDATE', [f.report.caseId]);
    const stepId = await recordCounterNotice(client, {
      caseId: f.report.caseId, reportId, decisionId: restriction.decisionId,
      principalId: f.principalId, partySubject: f.actor, statement: 'This Realm was restricted by mistake.',
      contentLanguage: 'en', declarations: { signature: 'Subscriber signature', materialLocation: f.realm,
        goodFaithMistakeUnderPerjury: true, name: 'Subscriber', address: 'Subscriber address',
        phone: '+1 555 987 1234', courtJurisdiction: 'Federal District Court', consentToJurisdiction: true,
        acceptService: true }, key: randomUUID(), requestDigest: 'd'.repeat(64), now: receivedAt,
    });
    if (delivered) await client.query(`UPDATE access.rights_counter_notice
      SET delivered_at = received_at, phase = 'waiting' WHERE step_id = $1`, [stepId]);
    const row = (await client.query<{ not_before: Date }>(
      'SELECT not_before FROM access.rights_counter_notice WHERE step_id = $1', [stepId])).rows[0]!;
    await client.query('COMMIT');
    return { stepId, notBefore: row.not_before };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function claimantStay(f: Fixture, restriction: DecisionResult) {
  await f.store.recordStep(f.principal, { caseId: f.report.caseId, decisionId: restriction.decisionId,
    actingSubject: f.actor, process: 'dmca_512', step: 'claimant_action', partySubject: null,
    statement: 'Claimant filed a court action.', documentDigest: null, occurredAt: '2026-10-01T14:37:12Z',
    dueAt: null, idempotencyKey: randomUUID() });
}

async function additionalCopyrightReport(f: Fixture) {
  const evidence = { owner: 'graph' as const, resource: f.realm, component: 'record' as const,
    locator: null, revision: f.evidenceHead };
  const report = await f.store.submitReport(f.principal, {
    kind: 'rights_complaint', actingSubject: f.actor,
    authority: { kind: 'platform', scopeId: 'governance:platform' }, context: GLOBAL_CONTEXT,
    target: evidence, evidence: [evidence], disclosure: 'private', reasonCode: 'copyright',
    statement: 'A second claimant reports the same Realm record.', idempotencyKey: randomUUID(),
    complaint: { process: 'dmca_512', claimantKind: 'rights_holder', claimantName: 'Second claimant',
      claimantContact: null, claimedWork: f.realm, claimedRight: 'copyright', noticeDigest: 'e'.repeat(64),
      noticeReceivedAt: '2026-10-01T14:37:12Z' },
  });
  expect(report.caseId).toBe(f.report.caseId);
  expect(report.reportId).not.toBe(f.report.reportId);
  return report;
}

for (const gate of ['queued', 'unripe'] as const) {
  for (const dispatch of ['manual', 'scheduled'] as const) {
    test(`${dispatch} Realm restoration cannot skip a second ${gate} counter-notice beside a ripe delivered notice`, async () => {
      const f = await fixture({ kind: 'rights_complaint', process: 'dmca_512' });
      const original = await f.store.decide(f.principal, f.input);
      const first = await counterNotice(f, original);
      const secondReport = await additionalCopyrightReport(f);
      const second = await counterNotice(f, original, gate !== 'queued', secondReport.reportId,
        new Date('2026-10-02T14:37:12Z'));
      expect(second.notBefore.getTime()).toBeGreaterThan(first.notBefore.getTime());
      f.setClock(first.notBefore);
      const notices = (await pool.query(`SELECT delivered_at,not_before FROM access.rights_counter_notice
        WHERE restriction_id=$1 ORDER BY received_at`, [original.decisionId])).rows;
      expect(notices).toHaveLength(2);
      expect(notices[0]!.delivered_at).not.toBeNull();
      expect(notices[0]!.not_before.getTime()).toBeLessThanOrEqual(first.notBefore.getTime());
      expect(gate === 'queued' ? notices[1]!.delivered_at === null
        : notices[1]!.not_before.getTime() > first.notBefore.getTime()).toBe(true);
      if (dispatch === 'manual') {
        await expect(f.store.decide(f.principal, await f.release(original, 'restore', first.stepId)))
          .rejects.toBeInstanceOf(GovernanceStale);
      } else {
        await expect(f.store.restoreCounterNotice(first.stepId)).rejects.toBeInstanceOf(GovernanceStale);
      }
      await assertRestricted(f, original);
      expect(f.ownerCalls()).toBe(1);
      expect((await pool.query('SELECT 1 FROM access.moderation_decision WHERE case_id=$1',
        [f.report.caseId])).rowCount).toBe(1);
    });
  }
}

for (const gate of ['undelivered', 'unripe', 'claimant stay'] as const) {
  test(`DMCA Realm restoration rejects ${gate} with the original closure intact`, async () => {
    const f = await fixture({ kind: 'rights_complaint', process: 'dmca_512' });
    const original = await f.store.decide(f.principal, f.input);
    const notice = await counterNotice(f, original, gate !== 'undelivered');
    f.setClock(gate === 'unripe' ? new Date(notice.notBefore.getTime() - 1) : notice.notBefore);
    if (gate === 'claimant stay') await claimantStay(f, original);
    await expect(f.store.decide(f.principal, await f.release(original, 'restore', notice.stepId)))
      .rejects.toBeInstanceOf(GovernanceStale);
    await assertRestricted(f, original);
    expect(f.ownerCalls()).toBe(1);
  });
}

test('DMCA eligibility is rechecked after accepted Realm restoration and before owner dispatch', async () => {
  const f = await fixture({ kind: 'rights_complaint', process: 'dmca_512' });
  const original = await f.store.decide(f.principal, f.input);
  const notice = await counterNotice(f, original);
  f.setClock(notice.notBefore);
  const accepted = await f.store.decide(f.principal, await f.release(original, 'restore', notice.stepId), true);
  await claimantStay(f, original);
  const resumed = await f.store.resumeDecision(f.principal, f.actor, accepted.decisionId);
  expect(resumed.operation.status).toBe('partial');
  expect(resumed.operation.items[0]?.state).toBe('failed');
  await assertRestricted(f, original);
  expect(f.ownerCalls()).toBe(1);
});

test('scheduled eligible Realm restoration uses the original source and current head and replays durably', async () => {
  const f = await fixture({ kind: 'rights_complaint', process: 'dmca_512' });
  const original = await f.store.decide(f.principal, f.input);
  const notice = await counterNotice(f, original);
  f.setClock(notice.notBefore);
  f.setHead(native());
  const restored = await f.store.restoreCounterNotice(notice.stepId);
  expect(restored.phase).toBe('done');
  if (!restored.decisionId) throw new Error('Completed scheduled restoration needs a decision');
  const retry = await f.store.restoreCounterNotice(notice.stepId);
  expect(retry).toEqual(restored);
  expect(f.committedOwners()).toBe(2);
  expect(await closureFence(f)).toEqual([{ decision_id: restored.decisionId, state: 'released', fence_epoch: '2' }]);
  expect(f.seenPlans.at(-1)?.restorationRestrictionId).toBe(original.decisionId);
});

async function productionJson<T>(response: Response, status = 201): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

test('production Realm release recovers its native receipt after Access acknowledgement rollback and owner profile change', async () => {
  const stack = await startMediaStack('realm-release-receipt');
  const store = stack.composition.dependencies.governance!.store;
  try {
    const staff = await stack.member('realm-release-staff');
    const grant = (scope: string, action: string) => grantFixtureAuthority(stack.accessPool, {
      scope, requireDispatch: true,
      representations: [{ principalId: staff.principalId, actor: staff.actor, action, lifetime: 'infinity' }],
      grant: { actor: staff.actor, action, lifetime: 'infinity' },
    });
    await grant('space:create:root', 'space.create');
    const created = await productionJson<{ realm: string; space: string }>(await staff.send('POST',
      '/v1/spaces', { profile: 'space-realm-v1', name: 'Receipt recovery Realm', capabilities: ['realm'],
        actingSubject: staff.actor }));
    await grant(`realm:profile:${created.realm}`, 'realm.profile.publish');
    await productionJson(await staff.send('PUT', `/v1/realms/${created.realm.slice(-36)}/profile`, {
      profile: 'realm-public-profile-v2', expectedHead: null, actingSubject: staff.actor,
      publication: { name: { original: 'en', labels: { en: 'Receipt recovery public Realm' } },
        description: { original: 'en', labels: { en: 'A retained public record for receipt recovery.' } },
        iconSelection: null, bannerSelection: null, moderators: [],
        count: { kind: 'unknown', value: null } },
    }));
    const head = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(created.realm)} rv:head ?head }
    }`)).results!.bindings[0]!.head!.value;
    const report = await productionJson<{ caseId: string; reportId: string }>(await staff.send('POST',
      '/v1/public-reports', { profile: 'public-report-v1', target: created.realm,
        category: 'spam_or_manipulation', statement: 'Review the retained public Realm record.',
        contentLanguage: 'en', actingSubject: staff.actor }));
    const basis = (await stack.accessPool.query<{ generation: string; evidence_digest: string }>(
      `SELECT c.generation::text,r.evidence_digest FROM access.governance_case c
        JOIN access.governance_report r ON r.case_id=c.id WHERE r.id=$1`, [report.reportId])).rows[0]!;
    await grant('governance:platform', DECIDE_ACTION.content_report);
    await grant('governance:platform', RULE_PUBLISH_ACTION);
    const publishedRule = await stack.composition.dependencies.governance!.rules!.publish(staff.principal, {
      ref: `urn:rule:receipt:${randomUUID()}`, scopeId: 'governance:platform', actingSubject: staff.actor,
      expectedRevision: null, document: { reason: 'Protect the public Realm record' }, idempotencyKey: randomUUID(),
    });
    await store.safety.claim(staff.principal, staff.actor, report.caseId);
    const input: DecisionInput = {
      caseId: report.caseId, expectedGeneration: basis.generation, actingSubject: staff.actor,
      outcome: 'restrict', targets: [{ owner: 'graph', resource: created.realm, component: 'record',
        locator: null, scopeKind: 'component', revision: null, expectedHead: head, effect: 'disclosure' }],
      rule: { ref: publishedRule.ref, revision: publishedRule.revision, digest: publishedRule.digest },
      evidenceDigest: basis.evidence_digest, reversesDecisionId: null, answersStepId: null,
      rationale: null, disclosure: 'private', idempotencyKey: randomUUID(),
      reasons: { facts: 'The public Realm record was reviewed.', scope: 'The whole Realm record.',
        duration: 'Until reconsideration.', automation: false, contentLanguage: 'en',
        appealRoute: '/v1/public-reports/{caseId}/correspondence' },
    };
    const restricted = await store.decide(staff.principal, input);
    expect(restricted.operation.status).toBe('completed');
    await store.safety.claim(staff.principal, staff.actor, report.caseId);
    const release: DecisionInput = { ...input, outcome: 'restore', expectedGeneration: restricted.caseGeneration,
      idempotencyKey: randomUUID() };
    const accepted = await store.decide(staff.principal, release, true);
    expect(accepted.operation.status).toBe('accepted');
    let loseAck = true, ownerCommands = 0;
    const command = stack.fuseki.commandWithReceipt.bind(stack.fuseki);
    stack.fuseki.commandWithReceipt = async (...args) => { ownerCommands++; return command(...args); };
    // Keep the real production evidence, plans, owner adapter and native command;
    // only the composed store's Access acknowledgement transport loses one reply.
    const faultPool = new Proxy(stack.accessPool, { get(target, property) {
      if (property === 'connect') return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, member) {
          if (member === 'query') return async (...args: unknown[]) => {
            if (loseAck && typeof args[0] === 'string'
              && args[0].includes("UPDATE access.safety_decision_effect SET state = 'confirmed'")) {
              loseAck = false;
              throw new Error('Lost Access acknowledgement after native graph commitment');
            }
            return Reflect.apply(connection.query, connection, args);
          };
          const value = Reflect.get(connection, member);
          return typeof value === 'function' ? value.bind(connection) : value;
        } });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    Object.assign(store, { pool: faultPool });
    const uncertain = await store.resumeDecision(staff.principal, staff.actor, accepted.decisionId);
    expect(loseAck).toBe(false);
    expect(uncertain.operation.status).toBe('partial');
    expect(uncertain.operation.items[0]).toMatchObject({ state: 'uncertain', receipt: null });
    const fence = async () => (await stack.accessPool.query(`SELECT decision_id,state,fence_epoch::text
      FROM access.governance_enforcement WHERE resource=$1 AND component='record' AND revision IS NULL
        AND effect='disclosure'`, [created.realm])).rows;
    expect(await fence()).toEqual([{ decision_id: restricted.decisionId, state: 'restricted', fence_epoch: '1' }]);
    const receipt = `urn:rezics:receipt:moderation:${hash(`governance-moderation:${accepted.decisionId}:1`)}`;
    const nativeReceipt = async () => (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence ?target ?work WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:sequence ?sequence ; rv:moderationTarget ?target ; rv:work ?work }
    }`)).results!.bindings;
    const committed = await nativeReceipt();
    expect(committed).toHaveLength(1);
    expect(committed[0]!.target!.value).toBe(created.realm);
    expect(committed[0]!.work!.value).toBe(created.realm);
    expect((await stack.accessPool.query('SELECT 1 FROM access.outbox WHERE moderation_decision_id=$1',
      [accepted.decisionId])).rowCount).toBe(0);
    const nextHead = native();
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(created.realm)} rv:head ?head ; rv:definitionProfile ?profile }
    } INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(created.realm)} rv:head ${iri(nextHead)} ;
      rv:definitionProfile <urn:realm-receipt:changed-profile> }
    } WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(created.realm)} rv:head ?head .
      OPTIONAL { ${iri(created.realm)} rv:definitionProfile ?profile } } }`);
    const replay = await store.decide(staff.principal, release);
    expect(replay.replayed).toBe(true);
    expect(replay.decisionId).toBe(accepted.decisionId);
    expect(replay.operation.status).toBe('completed');
    expect(replay.operation.items[0]).toMatchObject({ state: 'confirmed', receipt });
    expect(ownerCommands).toBe(1);
    expect(await nativeReceipt()).toEqual(committed);
    expect(await fence()).toEqual([{ decision_id: accepted.decisionId, state: 'released', fence_epoch: '2' }]);
    const repeat = await store.decide(staff.principal, release);
    expect(repeat.decisionId).toBe(accepted.decisionId);
    expect(repeat.operation.status).toBe('completed');
    expect(ownerCommands).toBe(1);
    expect(await fence()).toEqual([{ decision_id: accepted.decisionId, state: 'released', fence_epoch: '2' }]);
    expect((await stack.accessPool.query('SELECT 1 FROM access.outbox WHERE moderation_decision_id=$1',
      [accepted.decisionId])).rowCount).toBe(1);
    expect((await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?event WHERE {
      GRAPH ${iri(GRAPHS.outbox)} { ?event rv:receipt ${iri(receipt)} }
    }`)).results!.bindings).toHaveLength(1);
  } finally {
    Object.assign(store, { pool: stack.accessPool });
    await stack.stop();
  }
}, 120_000);

for (const corruption of ['local authority', 'wrong scope', 'nonglobal context'] as const) {
  test(`scheduled Realm restoration rejects retained ${corruption} despite valid current action authority`, async () => {
    const f = await fixture({ kind: 'rights_complaint', process: 'dmca_512' });
    const original = await f.store.decide(f.principal, f.input);
    const notice = await counterNotice(f, original);
    f.setClock(notice.notBefore);
    const scope = corruption === 'wrong scope' ? `governance:resource:${f.realm}` : 'governance:platform';
    await grantFixtureAuthority(pool, { scope, requireDispatch: true,
      representations: [{ principalId: f.principalId, actor: f.actor,
        action: DECIDE_ACTION.rights_complaint, lifetime: 'infinity' }],
      grant: { actor: f.actor, action: DECIDE_ACTION.rights_complaint, lifetime: 'infinity' } });
    // Retained legacy jurisdiction is observed at the scheduler's own durable
    // read boundary; the correct live case and its immutable decisions remain intact.
    f.readScheduledJurisdiction({ authority_kind: corruption === 'local authority' ? 'resource_owner' : 'platform',
      authority_scope_id: scope, context: corruption === 'nonglobal context' ? f.realm : GLOBAL_CONTEXT });
    await expect(f.store.restoreCounterNotice(notice.stepId)).rejects.toBeInstanceOf(GovernanceDenied);
    expect(f.scheduledBasisReads()).toBe(1);
    await assertRestricted(f, original);
    expect(f.ownerCalls()).toBe(1);
    expect((await pool.query('SELECT 1 FROM access.moderation_decision WHERE case_id=$1',
      [f.report.caseId])).rowCount).toBe(1);
  });
}
