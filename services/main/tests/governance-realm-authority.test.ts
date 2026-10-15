import { afterAll, beforeAll, expect, test } from 'bun:test';
import { foregroundCounted } from '../../../tests/qa/integration/support/operation-cost.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { png, startMediaStack, type MediaStack } from '../../../tests/qa/integration/media-support.ts';
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
import { MediaStore } from '../src/modules/media/store.ts';
import { SPACE_REALM_PROFILE } from '../src/modules/space/create.ts';
import { RULE_PUBLISH_ACTION } from '../src/modules/governance/rules.ts';
import { GRAPHS, RV, iri } from '../src/modules/work/activate.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { reportRoutes } from '../src/routes/reports.ts';
import { rightsRoutes } from '../src/routes/rights.ts';
import { safetyCaseRoutes } from '../src/routes/safety-cases.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const rule = { ref: 'urn:rule:realm-jurisdiction', revision: '1', digest: 'a'.repeat(64) };
let cluster: PostgresCluster | undefined;
let pool: Pool;
let productionStack: Promise<MediaStack> | undefined;
const production = () => productionStack ??= startMediaStack('realm-authority', { profileCredits: true });

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
  if (productionStack) await (await productionStack).stop();
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

async function productionJson<T>(response: Response, status = 201): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

/** Read old saved rows through the real store without weakening SQL write guards. */
async function withSavedRead<T>(database: Pool, decisionId: string,
  transform: (row: Record<string, unknown>, sql: string) => Record<string, unknown>,
  work: () => Promise<T>): Promise<T> {
  const connect = database.connect.bind(database);
  const decorate = (client: PoolClient) => {
    const query = client.query;
    const read = query.bind(client);
    const release = client.release;
    client.query = (async (sql: string, values?: unknown[]) => {
      const result = await read<Record<string, unknown>>(sql, values);
      if (values?.[0] === decisionId && sql.trimStart().startsWith('SELECT')) {
        result.rows = result.rows.map(row => transform(row, sql));
      }
      return result;
    }) as typeof client.query;
    client.release = (error?: Error | boolean) => {
      client.query = query;
      client.release = release;
      release.call(client, error);
    };
    return client;
  };
  database.connect = ((callback?: Parameters<Pool['connect']>[0]) => {
    if (callback) return connect(callback);
    return connect().then(decorate);
  }) as typeof database.connect;
  try { return await work(); }
  finally { database.connect = connect; }
}

/** All heads, evidence, rules, plans and receipts come from Main's composition. */
async function productionFixture(kind: 'content_report' | 'rights_complaint' = 'content_report',
  resourceKind: 'Realm' | 'Space' | 'Agent' | 'Concept' = 'Realm',
  authority: 'platform' | 'realm' = 'platform') {
  const stack = await production();
  const member = await stack.member(`authority-${randomUUID()}`);
  const grant = (scope: string, action: string) => grantFixtureAuthority(stack.accessPool, {
    scope, requireDispatch: true,
    representations: [{ principalId: member.principalId, actor: member.actor, action, lifetime: 'infinity' }],
    grant: { actor: member.actor, action, lifetime: 'infinity' },
  });
  await grant('space:create:root', 'space.create');
  const created = await productionJson<{ realm: string; space: string; realmRevision: string }>(
    await member.send('POST', '/v1/spaces', { profile: 'space-realm-v1', name: 'Authority Realm',
      capabilities: ['realm'], actingSubject: member.actor }));
  await grant(`realm:profile:${created.realm}`, 'realm.profile.publish');
  const published = await productionJson<{ revision: string }>(await member.send('PUT',
    `/v1/realms/${created.realm.slice(-36)}/profile`, {
      profile: 'realm-public-profile-v2', expectedHead: null, actingSubject: member.actor,
      publication: { name: { original: 'en', labels: { en: 'Authority public profile' } },
        description: { original: 'en', labels: { en: 'The retained public record.' } },
        iconSelection: null, bannerSelection: null, moderators: [],
        count: { kind: 'unknown', value: null } },
    }));
  let resource = resourceKind === 'Space' ? created.space : resourceKind === 'Agent' ? member.actor : created.realm;
  if (resourceKind === 'Concept') {
    await grant('classification:define:global', 'classification.proposition.define');
    // The vocabulary operation gives the Concept its own retained head, as an imported one has.
    resource = (await productionJson<{ concept: string }>(await member.send('POST',
      '/v1/classification-vocabulary', { profile: 'classification-proposition-v2', scheme: null,
        labels: [{ language: 'en', value: 'Authority Concept' }], alternativeLabels: [],
        broader: [], narrower: [], actingSubject: member.actor }))).concept;
  }
  const head = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(resource)} rv:head ?head }
  }`)).results!.bindings[0]!.head!.value;
  const report = await productionJson<{ caseId: string; reportId: string; credential: string }>(
    await member.send('POST', '/v1/public-reports', { profile: 'public-report-v1', target: resource,
      category: authority === 'realm' ? 'realm_rules'
        : kind === 'rights_complaint' ? 'copyright' : 'spam_or_manipulation',
      statement: 'Please review this public record.', contentLanguage: 'en',
      actingSubject: member.actor,
      ...(authority === 'realm' ? { realm: created.realm } : {}),
      ...(kind === 'rights_complaint' ? { contactEmail: 'claimant@authority.test', copyright: {
        signature: 'Claimant', claimantName: 'Claimant', claimantAddress: 'Claimant address',
        claimantPhone: '+1 555 555 5555', claimedWork: 'Original authored work', materialLocation: resource,
        goodFaith: true, accurateAndAuthorizedUnderPerjury: true,
      } } : {}),
    }));
  const basis = (await stack.accessPool.query<{ generation: string; evidence_digest: string }>(
    `SELECT c.generation::text,r.evidence_digest FROM access.governance_case c
     JOIN access.governance_report r ON r.case_id=c.id WHERE r.id=$1`, [report.reportId])).rows[0]!;
  const scope = authority === 'realm' ? `governance:realm:${created.realm}` : 'governance:platform';
  await grant(scope, DECIDE_ACTION[kind]);
  await grant(scope, RULE_PUBLISH_ACTION);
  const governance = stack.composition.dependencies.governance!;
  const currentRule = await governance.rules!.publish(member.principal, {
    ref: `urn:rule:authority:${randomUUID()}`, scopeId: scope, actingSubject: member.actor,
    expectedRevision: null, document: { reason: 'Protect the public record' }, idempotencyKey: randomUUID(),
  });
  if (authority === 'platform') await governance.store.safety.claim(member.principal, member.actor, report.caseId);
  const input: DecisionInput = {
    caseId: report.caseId, expectedGeneration: basis.generation, actingSubject: member.actor,
    outcome: kind === 'rights_complaint' ? 'final_restrict' : 'restrict',
    targets: [{ owner: 'graph', resource, component: 'record', locator: null, scopeKind: 'component',
      revision: null, expectedHead: head, effect: 'disclosure' }],
    rule: { ref: currentRule.ref, revision: currentRule.revision, digest: currentRule.digest },
    evidenceDigest: basis.evidence_digest, reversesDecisionId: null, answersStepId: null,
    rationale: null, disclosure: 'private', idempotencyKey: randomUUID(),
    reasons: { facts: 'The retained public record was reviewed.', scope: 'The record.',
      duration: 'Until reconsideration.', automation: false, contentLanguage: 'en',
      appealRoute: '/v1/public-reports/{caseId}/correspondence' },
  };
  return { stack, member, grant, store: governance.store, rules: governance.rules!, input, report,
    realm: created.realm, space: created.space, head, publicProfileHead: published.revision, resource };
}

test('production Realm authority can restrict exact-revision record disclosure without closing the Realm', async () => {
  const f = await productionFixture('content_report', 'Realm', 'realm');
  const result = await f.store.decide(f.member.principal, { ...f.input,
    targets: [{ ...f.input.targets[0]!, scopeKind: 'exact_revision', revision: f.publicProfileHead }] });
  expect(result.operation.status).toBe('completed');
  expect(result.enforcement).toMatchObject([{ resource: f.realm,
    revision: f.publicProfileHead, effect: 'disclosure', state: 'restricted' }]);
  expect((await f.stack.accessPool.query(`SELECT 1 FROM access.governance_enforcement
    WHERE resource=$1 AND component='record' AND revision IS NULL AND effect='disclosure'`,
  [f.realm])).rowCount).toBe(0);
});

for (const authority of ['resource_owner', 'realm'] as const) {
  test(`${authority} authority can restrict exact-revision Realm record disclosure`, async () => {
    const f = await fixture({ authority });
    const result = await f.store.decide(f.principal, { ...f.input,
      targets: [{ ...f.input.targets[0]!, scopeKind: 'exact_revision', revision: f.head }] });
    expect(result.operation.status).toBe('completed');
    expect(result.enforcement).toMatchObject([{ resource: f.realm,
      revision: f.head, effect: 'disclosure', state: 'restricted' }]);
    expect(f.applications()).toBe(1);
  });
}

test('production Realm public evidence is retained at publicProfileHead while closure CAS uses rv:head', async () => {
  const f = await productionFixture();
  expect(f.publicProfileHead).not.toBe(f.head);
  expect((await f.stack.accessPool.query('SELECT revision,state,representation FROM access.governance_evidence WHERE report_id=$1',
    [f.report.reportId])).rows).toEqual([{ revision: f.publicProfileHead, state: 'available', representation: 'graph-anchor-v1' }]);
  await expect(f.store.decide(f.member.principal, { ...f.input,
    targets: [{ ...f.input.targets[0]!, expectedHead: f.publicProfileHead }] })).rejects.toBeInstanceOf(GovernanceStale);
  const result = await f.store.decide(f.member.principal, f.input);
  expect(result.operation.status).toBe('completed');
  expect(result.enforcement).toMatchObject([{ resource: f.realm, state: 'restricted' }]);
  expect((await f.stack.accessPool.query('SELECT plan FROM access.safety_decision_effect WHERE decision_id=$1',
    [result.decisionId])).rows[0]!.plan.realm).toEqual({ realm: f.realm, space: f.space });
});

test('production active Concept record/search remains an admitted Access restriction', async () => {
  const f = await productionFixture('content_report', 'Concept');
  const result = await f.store.decide(f.member.principal, { ...f.input,
    targets: [{ ...f.input.targets[0]!, effect: 'search' }] });
  expect(result.operation.status).toBe('completed');
  expect(result.enforcement).toMatchObject([{ resource: f.resource, effect: 'search', state: 'restricted' }]);
});

for (const resourceKind of ['Agent', 'Space'] as const) {
  test(`production confirmed legacy ${resourceKind} record/search replay needs no graph owner read`, async () => {
    const f = await productionFixture('content_report', resourceKind);
    const input = { ...f.input, targets: [{ ...f.input.targets[0]!, effect: 'search' as const }] };
    const confirmed = await f.store.decide(f.member.principal, input);
    expect(confirmed.operation.status).toBe('completed');
    const original = f.stack.fuseki.query;
    const replayScope = new AsyncLocalStorage<boolean>();
    let reads = 0;
    // Directory refresh runs independently on this production stack. Only
    // graph reads initiated by the replay belong to its no-owner-read proof.
    f.stack.fuseki.query = async (...args) => {
      if (foregroundCounted() && replayScope.getStore()) {
        reads++;
        throw new Error('Graph owner unavailable during retained-key replay');
      }
      return original.apply(f.stack.fuseki, args);
    };
    try {
      const replay = await replayScope.run(true, () => withSavedRead(f.stack.accessPool, confirmed.decisionId, row => {
        if (!row.plan) return row;
        const plan = { ...row.plan as Record<string, unknown> };
        delete plan.realm;
        return { ...row, plan };
      }, () => f.store.decide(f.member.principal, input)));
      expect(replay.decisionId).toBe(confirmed.decisionId);
      expect(replay.operation.status).toBe('completed');
      expect(reads).toBe(0);
    } finally { f.stack.fuseki.query = original; }
  });
}

for (const component of ['body', 'structure'] as const) {
  for (const effect of ['participation', 'capability'] as const) {
    test(`production resume rejects a persisted Realm ${component}/${effect} grain before Access confirmation`, async () => {
      const f = await productionFixture();
      const accepted = await f.store.decide(f.member.principal, { ...f.input,
        targets: [{ ...f.input.targets[0]!, effect, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }] }, true);
      expect(accepted.operation.status).toBe('accepted');
      // Model a saved pre-upgrade plan: resume must validate the dispatched grain
      // even when the original acceptance bypassed today's owner classification.
      const result = await withSavedRead(f.stack.accessPool, accepted.decisionId,
        row => row.resource === f.realm && row.component === 'record' ? { ...row, component } : row,
        () => f.store.resumeDecision(f.member.principal, f.member.actor, accepted.decisionId));
      expect(result.operation.status).not.toBe('completed');
      expect((await f.stack.accessPool.query('SELECT 1 FROM access.governance_enforcement WHERE decision_id=$1',
        [accepted.decisionId])).rowCount).toBe(0);
      expect((await f.stack.accessPool.query('SELECT state FROM access.safety_decision_effect WHERE decision_id=$1',
        [accepted.decisionId])).rows[0]!.state).not.toBe('confirmed');
    });
  }
}

for (const kind of ['content_report', 'rights_complaint'] as const) {
  for (const jurisdiction of ['resource_owner', 'realm', 'wrong_scope', 'non_global'] as const) {
    test(`production ${kind} resume rejects saved Realm ${jurisdiction} jurisdiction with valid action authority`, async () => {
      const f = await productionFixture(kind);
      const accepted = await f.store.decide(f.member.principal, f.input, true);
      expect(accepted.operation.status).toBe('accepted');
      const scope = jurisdiction === 'realm' ? `governance:realm:${f.realm}`
        : jurisdiction === 'resource_owner' || jurisdiction === 'wrong_scope'
          ? `governance:resource:${f.space}` : 'governance:platform';
      await f.grant(scope, DECIDE_ACTION[kind]);
      const authorityKind = jurisdiction === 'resource_owner' || jurisdiction === 'realm'
        ? jurisdiction : 'platform';
      await expect(withSavedRead(f.stack.accessPool, accepted.decisionId, row =>
        'authority_kind' in row ? { ...row, authority_kind: authorityKind,
          authority_scope_id: scope, context: jurisdiction === 'non_global' || jurisdiction === 'realm'
            ? f.realm : GLOBAL_CONTEXT } : row,
      () => f.store.resumeDecision(f.member.principal, f.member.actor, accepted.decisionId)))
        .rejects.toThrow('whole-Realm disclosure requires platform/global jurisdiction');
      expect((await f.stack.accessPool.query('SELECT 1 FROM access.governance_enforcement WHERE decision_id=$1',
        [accepted.decisionId])).rowCount).toBe(0);
      expect((await f.stack.accessPool.query('SELECT state FROM access.safety_decision_effect WHERE decision_id=$1',
        [accepted.decisionId])).rows[0]!.state).toBe('pending');
      // The unchanged saved platform basis succeeds immediately: action authority
      // and the reviewed owner head stayed valid throughout the refusal.
      const completed = await f.store.resumeDecision(f.member.principal, f.member.actor, accepted.decisionId);
      expect(completed.operation.status).toBe('completed');
    });
  }
}

test('production resume rejects a saved non-Realm plan before live Realm dispatch under local authority', async () => {
  const f = await productionFixture();
  const accepted = await f.store.decide(f.member.principal, f.input, true);
  expect(accepted.operation.status).toBe('accepted');
  const scope = `governance:resource:${f.space}`;
  await f.grant(scope, DECIDE_ACTION.content_report);
  const result = await withSavedRead(f.stack.accessPool, accepted.decisionId, row => {
    if ('authority_kind' in row) return { ...row, authority_kind: 'resource_owner',
      authority_scope_id: scope };
    if (row.plan) return { ...row, plan: { ...row.plan as Record<string, unknown>, realm: null } };
    return row;
  }, () => f.store.resumeDecision(f.member.principal, f.member.actor, accepted.decisionId));
  expect(result.operation.status).not.toBe('completed');
  expect((await f.stack.accessPool.query('SELECT 1 FROM access.governance_enforcement WHERE decision_id=$1',
    [accepted.decisionId])).rowCount).toBe(0);
  expect((await f.stack.accessPool.query('SELECT state FROM access.safety_decision_effect WHERE decision_id=$1',
    [accepted.decisionId])).rows[0]!.state).not.toBe('confirmed');
  const receipts = () => f.stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:moderationTarget ${iri(f.realm)} }
  } LIMIT 2`, 4096);
  expect((await receipts()).results?.bindings ?? []).toHaveLength(0);
  const completed = await f.store.resumeDecision(f.member.principal, f.member.actor, accepted.decisionId);
  expect(completed.operation.status).toBe('completed');
  expect(completed.enforcement).toMatchObject([{ resource: f.realm, state: 'restricted' }]);
  expect((await receipts()).results?.bindings ?? []).toHaveLength(1);
});

test('production graph Realm dispatch cannot bypass saved owner validation through a media plan', async () => {
  const f = await productionFixture();
  const uploaded = await f.member.upload(png(16, 16));
  const media = (await f.stack.contentPool.query<{ source: string; state: string; digest: string }>(`
    SELECT p.id::text AS source,a.state_head::text AS state,p.byte_digest AS digest
    FROM media.asset a JOIN media.representation p ON p.asset_id=a.id
    WHERE a.id=$1 AND p.kind='original'`, [uploaded.asset.slice(-36)])).rows[0]!;
  expect(media).toBeDefined();
  const accepted = await f.store.decide(f.member.principal, f.input, true);
  expect(accepted.operation.status).toBe('accepted');
  const scope = `governance:resource:${f.space}`;
  await f.grant(scope, DECIDE_ACTION.content_report);
  const original = MediaStore.prototype.moderateOriginal;
  let mediaCalls = 0;
  MediaStore.prototype.moderateOriginal = async function (this: MediaStore,
    ...args: Parameters<MediaStore['moderateOriginal']>) {
    mediaCalls++;
    return original.apply(this, args);
  };
  try {
    const result = await withSavedRead(f.stack.accessPool, accepted.decisionId, row => {
      if ('authority_kind' in row) return { ...row, authority_kind: 'resource_owner', authority_scope_id: scope };
      if (row.plan) return { ...row, plan: { ...row.plan as Record<string, unknown>, realm: null, media } };
      return row;
    }, () => f.store.resumeDecision(f.member.principal, f.member.actor, accepted.decisionId));
    expect(result.operation.status).not.toBe('completed');
    expect(mediaCalls).toBe(0);
    expect((await f.stack.accessPool.query('SELECT 1 FROM access.governance_enforcement WHERE decision_id=$1',
      [accepted.decisionId])).rowCount).toBe(0);
    expect((await f.stack.accessPool.query('SELECT state FROM access.safety_decision_effect WHERE decision_id=$1',
      [accepted.decisionId])).rows[0]!.state).not.toBe('confirmed');
    expect((await f.stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:moderationTarget ${iri(f.realm)} }
    } LIMIT 2`, 4096)).results?.bindings ?? []).toHaveLength(0);
    const completed = await f.store.resumeDecision(f.member.principal, f.member.actor, accepted.decisionId);
    expect(completed.operation.status).toBe('completed');
    expect(completed.enforcement).toMatchObject([{ resource: f.realm, state: 'restricted' }]);
    expect(mediaCalls).toBe(0);
  } finally { MediaStore.prototype.moderateOriginal = original; }
});

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
    const restrictionOutcomes: DecisionOutcome[] = kind === 'content_report'
      ? ['restrict'] : ['interim_restrict', 'final_restrict'];
    for (const outcome of restrictionOutcomes) {
    test(`${transport.name}: ${kind} platform/global Realm ${outcome} persists authority before dispatch`, async () => {
      const f = await fixture({ kind });
      const response = await throughTransport(f, transport, { ...f.input, outcome });
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
    for (const releaseOutcome of ['restore', 'reverse'] as const) {
      test(`${transport.name}: ${kind} platform/global Realm ${releaseOutcome} releases its ${outcome} restriction`, async () => {
        const f = await fixture({ kind });
        const restricted = await f.store.decide(f.principal, { ...f.input, outcome });
        expect(restricted.operation.status).toBe('completed');
        const answersStepId = kind === 'rights_complaint' && releaseOutcome === 'restore'
          ? (await f.store.recordStep(f.principal, { caseId: f.report.caseId,
            decisionId: restricted.decisionId, actingSubject: f.actor,
            process: 'ordinary_dispute', step: 'appeal', partySubject: null,
            statement: 'Reconsider the original Realm restriction.', documentDigest: null,
            occurredAt: '2026-10-01T14:37:12Z', dueAt: null, idempotencyKey: randomUUID() })).stepId
          : null;
        await f.store.safety.claim(f.principal, f.actor, f.report.caseId);
        const releaseInput = { ...f.input,
          outcome: releaseOutcome, expectedGeneration: restricted.caseGeneration,
          reversesDecisionId: releaseOutcome === 'reverse' ? restricted.decisionId : null,
          answersStepId, idempotencyKey: randomUUID() };
        const response = await throughTransport(f, transport, releaseInput);
        expect(response.status).toBe(202);
        const accepted = await response.json() as { decisionId: string; operation: { status: string } };
        expect(accepted.operation.status).toBe('accepted');
        expect(f.applications()).toBe(1);
        expect((await pool.query('SELECT plan FROM access.safety_decision_effect WHERE decision_id=$1',
          [accepted.decisionId])).rows[0]!.plan.restorationRestrictionId).toBe(restricted.decisionId);
        const released = await f.store.resumeDecision(f.principal, f.actor, accepted.decisionId);
        expect(released.operation.status).toBe('completed');
        expect(released.enforcement).toMatchObject([{ resource: f.realm, state: 'released', fenceEpoch: '2' }]);
        expect(f.applications()).toBe(2);
        const replay = await throughTransport(f, transport, releaseInput);
        expect(replay.status).toBe(200);
        expect(await replay.json()).toMatchObject({ decisionId: accepted.decisionId,
          operation: { status: 'completed' }, replayed: true });
        expect(f.applications()).toBe(2);
      });
    }
    }
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
