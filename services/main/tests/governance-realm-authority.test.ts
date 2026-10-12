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
import {
  expireFixtureAuthority,
  grantFixtureAuthority,
} from '../src/modules/access/fixture-authority.ts';
import {
  DECIDE_ACTION,
  GLOBAL_CONTEXT,
  GovernanceDenied,
  GovernanceStale,
  GovernanceStore,
  type DecisionInput,
  type DecisionOutcome,
  type ReportInput,
} from '../src/modules/governance/store.ts';
import { recordCounterNotice } from '../src/modules/rights/counter-notice.ts';
import { SPACE_REALM_PROFILE } from '../src/modules/space/create.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { reportRoutes } from '../src/routes/reports.ts';
import { rightsRoutes } from '../src/routes/rights.ts';
import { safetyCaseRoutes } from '../src/routes/safety-cases.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const rule = { ref: 'urn:rule:realm-jurisdiction', revision: '1', digest: 'a'.repeat(64) };
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

async function fixture(options: {
  kind?: ReportInput['kind'];
  authority?: ReportInput['authority']['kind'];
  nonGlobal?: boolean;
  wrongScope?: boolean;
  claim?: boolean;
  grantedAction?: string;
  process?: 'ordinary_dispute' | 'dmca_512';
  isRealm?: boolean;
} = {}) {
  const kind = options.kind ?? 'content_report';
  const authority = options.authority ?? 'platform';
  const realm = native();
  const space = native();
  const head = native();
  const context = authority === 'realm' || options.nonGlobal ? realm : GLOBAL_CONTEXT;
  const scope = options.wrongScope ? `governance:resource:${space}`
    : authority === 'platform' ? 'governance:platform'
    : authority === 'realm' ? `governance:realm:${realm}` : `governance:resource:${space}`;
  const principalId = randomUUID();
  const principal: VerifiedPrincipal = {
    issuer: 'https://account.realm-authority.test',
    subject: randomUUID(),
  };
  const actor = native();
  await pool.query(
    'INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principalId, principal.issuer, principal.subject],
  );
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
  const action = options.grantedAction ?? DECIDE_ACTION[kind];
  await grantFixtureAuthority(pool, {
    scope,
    requireDispatch: true,
    representations: [{ principalId, actor, action, lifetime: 'infinity' }],
    grant: { actor, action, lifetime: 'infinity' },
  });
  let applications = 0;
  let now = new Date('2026-10-01T14:37:12Z');
  const store = new GovernanceStore(
    pool,
    {
      capture: async (_principal, _actor, target) => ({
        ...target,
        state: 'available',
        representation: head,
        revisionDigest: 'b'.repeat(64),
        provenance: {},
      }),
    },
    {
      current: async () => head,
      realmBasis: async (target) => options.isRealm === false || target.component !== 'record'
        ? null
        : { realm, space, head, profile: SPACE_REALM_PROFILE, profileId: 'space-realm-v3' },
    },
    { current: async () => rule },
    {
      participants: async () => [],
      apply: async (operationId, ordinal) => {
        applications++;
        return { receipt: `urn:receipt:${operationId}:${ordinal}` };
      },
    },
    undefined,
    () => now,
  );
  const evidence = {
    owner: 'graph' as const,
    resource: realm,
    component: 'record' as const,
    locator: null,
    revision: head,
  };
  const report = await store.submitReport(principal, {
    kind,
    actingSubject: actor,
    authority: { kind: authority, scopeId: scope },
    context,
    target: evidence,
    disclosure: 'private',
    reasonCode: 'spam',
    statement: 'Review the retained Realm record.',
    evidence: [evidence],
    idempotencyKey: randomUUID(),
    ...(kind === 'rights_complaint' ? {
      complaint: {
        process: options.process ?? 'ordinary_dispute',
        claimantKind: 'rights_holder' as const,
        claimantName: 'Claimant',
        claimantContact: null,
        claimedWork: realm,
        claimedRight: 'copyright' as const,
        noticeDigest: 'c'.repeat(64),
        noticeReceivedAt: now.toISOString(),
      },
    } : {}),
  });
  if (authority === 'platform' && !options.wrongScope && options.claim !== false
    && action === DECIDE_ACTION[kind]) {
    await store.safety.claim(principal, actor, report.caseId);
  }
  const input: DecisionInput = {
    caseId: report.caseId,
    expectedGeneration: report.caseGeneration,
    actingSubject: actor,
    outcome: kind === 'rights_complaint' ? 'final_restrict' : 'restrict',
    targets: [{ ...evidence, revision: null, scopeKind: 'component', expectedHead: head,
      effect: 'disclosure' }],
    rule,
    evidenceDigest: report.evidenceDigest,
    reversesDecisionId: null,
    answersStepId: null,
    rationale: null,
    disclosure: 'private',
    idempotencyKey: randomUUID(),
    reasons: {
      facts: 'The retained Realm record was reviewed.',
      scope: 'The whole Realm record.',
      duration: 'Until a platform reconsideration.',
      automation: false,
      contentLanguage: 'en',
      appealRoute: '/v1/public-reports/{caseId}/correspondence',
    },
  };
  return {
    store, principal, principalId, actor, realm, space, head, report, input,
    applications: () => applications,
    setClock(date: Date) { now = date; },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function expectNoDecision(f: Fixture) {
  expect(f.applications()).toBe(0);
  expect((await pool.query(
    'SELECT 1 FROM access.moderation_decision WHERE case_id = $1', [f.report.caseId],
  )).rowCount).toBe(0);
  expect((await pool.query(
    'SELECT 1 FROM access.governance_enforcement WHERE resource = $1', [f.realm],
  )).rowCount).toBe(0);
}

const transports = [
  { name: 'moderation', route: reportRoutes, profile: 'moderation-decision-v1',
    path: (_caseId: string) => '/v1/moderation/decisions', kinds: ['content_report', 'rights_complaint'] },
  { name: 'rights', route: rightsRoutes, profile: 'rights-restriction-v1',
    path: (_caseId: string) => '/v1/rights/restrictions', kinds: ['rights_complaint'] },
  { name: 'safety case', route: safetyCaseRoutes, profile: null,
    path: (caseId: string) => `/v1/safety-cases/${caseId}/decisions`,
    kinds: ['content_report', 'rights_complaint'] },
] as const;

async function throughTransport(
  f: Fixture,
  transport: typeof transports[number],
  input = f.input,
) {
  const dependencies = {
    account: { verify: async () => f.principal },
    governance: { store: f.store },
  } as unknown as MainWorkDependencies;
  return transport.route(dependencies).handle(new Request(
    `http://main.test${transport.path(input.caseId)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey },
      body: JSON.stringify({ ...(transport.profile ? { profile: transport.profile } : {}), ...input }),
    },
  ));
}

for (const transport of transports) {
  for (const kind of transport.kinds) {
    for (const authority of ['realm', 'resource_owner'] as const) {
      test(`${transport.name}: ${kind} ${authority} authority cannot close or restore the whole Realm`, async () => {
        const f = await fixture({ kind, authority });
        const outcomes: DecisionOutcome[] = kind === 'content_report'
          ? ['restrict', 'restore', 'reverse']
          : ['interim_restrict', 'final_restrict', 'restore', 'reverse'];
        for (const outcome of outcomes) {
          const response = await throughTransport(f, transport, {
            ...f.input,
            outcome,
            reversesDecisionId: outcome === 'reverse' ? randomUUID() : null,
            idempotencyKey: randomUUID(),
          });
          expect(response.status).toBe(403);
          expect(await response.json()).toMatchObject({
            title: 'whole-Realm disclosure requires platform/global jurisdiction',
          });
        }
        await expectNoDecision(f);
      });
    }
    test(`${transport.name}: ${kind} platform/global Realm decision persists authority before dispatch`, async () => {
      const f = await fixture({ kind });
      const response = await throughTransport(f, transport);
      expect(response.status).toBe(202);
      const result = await response.json() as { decisionId: string; operation: { status: string } };
      expect(result.operation.status).toBe('accepted');
      expect(f.applications()).toBe(0);
      const saved = (await pool.query<{ plan: { realm: { realm: string; space: string } } }>(
        'SELECT plan FROM access.safety_decision_effect WHERE decision_id = $1', [result.decisionId],
      )).rows[0]!;
      expect(saved.plan.realm).toEqual({ realm: f.realm, space: f.space });
      const completed = await f.store.resumeDecision(f.principal, f.actor, result.decisionId);
      expect(completed.operation.status).toBe('completed');
      expect(completed.enforcement).toMatchObject([{ resource: f.realm, state: 'restricted' }]);
      expect(f.applications()).toBe(1);
    });
  }
}

for (const kind of ['content_report', 'rights_complaint'] as const) {
  test(`${kind}: a platform action alone cannot close the Realm without the current case claim`, async () => {
    const f = await fixture({ kind, claim: false });
    await expect(f.store.decide(f.principal, f.input)).rejects.toThrow('claim the case before deciding');
    await expectNoDecision(f);
  });

  test(`${kind}: platform authority on a local context or another scope cannot close the Realm`, async () => {
    for (const options of [{ nonGlobal: true }, { wrongScope: true }]) {
      const f = await fixture({ kind, ...options });
      await expect(f.store.decide(f.principal, f.input)).rejects.toThrow(
        'whole-Realm disclosure requires platform/global jurisdiction',
      );
      await expectNoDecision(f);
    }
  });

  test(`${kind}: the other case kind's platform action does not confer closure authority`, async () => {
    const otherKind = kind === 'content_report' ? 'rights_complaint' : 'content_report';
    const f = await fixture({ kind, grantedAction: DECIDE_ACTION[otherKind] });
    await expect(f.store.decide(f.principal, f.input)).rejects.toBeInstanceOf(GovernanceDenied);
    await expectNoDecision(f);
    await grantFixtureAuthority(pool, {
      scope: 'governance:platform',
      requireDispatch: true,
      representations: [{ principalId: f.principalId, actor: f.actor,
        action: DECIDE_ACTION[kind], lifetime: 'infinity' }],
      grant: { actor: f.actor, action: DECIDE_ACTION[kind], lifetime: 'infinity' },
    });
    await f.store.safety.claim(f.principal, f.actor, f.report.caseId);
    expect((await f.store.decide(f.principal, f.input)).operation.status).toBe('completed');
    expect(f.applications()).toBe(1);
  });

  test(`${kind}: a stale public-profile head cannot authorize Realm closure`, async () => {
    const f = await fixture({ kind });
    await expect(f.store.decide(f.principal, {
      ...f.input,
      targets: [{ ...f.input.targets[0]!, expectedHead: native() }],
    })).rejects.toBeInstanceOf(GovernanceStale);
    await expectNoDecision(f);
  });

  test(`${kind}: revocation before resuming an accepted closure prevents owner dispatch`, async () => {
    const f = await fixture({ kind });
    const accepted = await f.store.decide(f.principal, f.input, true);
    expect(accepted.operation.status).toBe('accepted');
    await expireFixtureAuthority(pool, f.actor);
    await expect(f.store.resumeDecision(f.principal, f.actor, accepted.decisionId))
      .rejects.toBeInstanceOf(GovernanceDenied);
    expect(f.applications()).toBe(0);
    expect((await pool.query(
      'SELECT 1 FROM access.governance_enforcement WHERE resource = $1', [f.realm],
    )).rowCount).toBe(0);
  });
}

test('platform rights authority can confirm an interim whole-Realm disclosure restriction', async () => {
  const f = await fixture({ kind: 'rights_complaint' });
  const result = await f.store.decide(f.principal, { ...f.input, outcome: 'interim_restrict' });
  expect(result.operation.status).toBe('completed');
  expect(result.enforcement).toMatchObject([{ resource: f.realm, state: 'restricted' }]);
  expect(f.applications()).toBe(1);
});

test('the whole-Realm jurisdiction rule preserves narrower local restrictions and other graph kinds', async () => {
  for (const isRealm of [true, false]) {
    const f = await fixture({ authority: 'resource_owner', isRealm });
    const input = isRealm ? {
      ...f.input,
      targets: [{ ...f.input.targets[0]!, effect: 'search' as const }],
    } : f.input;
    expect((await f.store.decide(f.principal, input)).operation.status).toBe('completed');
    expect(f.applications()).toBe(1);
  }
});

test('scheduled Realm counter-notice restoration rechecks the original platform decider after revocation', async () => {
  const f = await fixture({ kind: 'rights_complaint', process: 'dmca_512' });
  const restricted = await f.store.decide(f.principal, f.input);
  expect(restricted.operation.status).toBe('completed');
  const client = await pool.connect();
  let stepId: string;
  let notBefore: Date;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM access.governance_case WHERE id = $1 FOR UPDATE',
      [f.report.caseId]);
    stepId = await recordCounterNotice(client, {
      caseId: f.report.caseId,
      reportId: f.report.reportId,
      decisionId: restricted.decisionId,
      principalId: f.principalId,
      partySubject: f.actor,
      statement: 'The subscriber contests this restriction.',
      contentLanguage: 'en',
      declarations: {
        signature: 'Subscriber signature',
        materialLocation: f.realm,
        goodFaithMistakeUnderPerjury: true,
        name: 'Subscriber',
        address: 'Subscriber address',
        phone: '+1 555 987 1234',
        courtJurisdiction: 'Federal District Court',
        consentToJurisdiction: true,
        acceptService: true,
      },
      key: randomUUID(),
      requestDigest: 'd'.repeat(64),
      now: new Date('2026-10-01T14:37:12Z'),
    });
    notBefore = (await client.query<{ not_before: Date }>(
      `UPDATE access.rights_counter_notice SET delivered_at = received_at, phase = 'waiting'
       WHERE step_id = $1 RETURNING not_before`, [stepId],
    )).rows[0]!.not_before;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  f.setClock(notBefore!);
  await expireFixtureAuthority(pool, f.actor);
  await expect(f.store.restoreCounterNotice(stepId!)).rejects.toBeInstanceOf(GovernanceDenied);
  expect(f.applications()).toBe(1);
  expect((await pool.query(
    'SELECT decision_id,state FROM access.governance_enforcement WHERE resource = $1', [f.realm],
  )).rows).toEqual([{ decision_id: restricted.decisionId, state: 'restricted' }]);
  expect((await pool.query(
    'SELECT 1 FROM access.moderation_decision WHERE case_id = $1', [f.report.caseId],
  )).rowCount).toBe(1);
});
