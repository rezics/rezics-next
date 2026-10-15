import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { FixtureAuthorityDenied, grantFixtureAuthority, registerFixtureIdentity } from '../src/modules/access/fixture-authority.ts';
import { KnownEffectFailure, ownerModerationEffects, type ModerationEffects } from '../src/modules/governance/effects.ts';
import { ContentCore, contentDraftIntentDigest, type SaveDraftCommand } from '../../content/src/core.ts';
import { ContentModeration } from '../../content/src/moderation.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { MediaStore, copySuppressionId, type UploadReservation } from '../src/modules/media/store.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { connectionBoundOptions } from '../src/infrastructure/pg-pool.ts';
import {
  GLOBAL_CONTEXT, GovernanceDenied, GovernanceStore, type DecisionInput, type EvidenceTarget,
} from '../src/modules/governance/store.ts';
import { mintPartyCredential, PublicReports } from '../src/modules/public-report/store.ts';
import { CATEGORY_VERSION, publicReportStatus } from '../src/modules/public-report/contract.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
let cluster: PostgresCluster | undefined;
let pool: Pool;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 6, options: connectionBoundOptions() });
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
  await migrateContent(pool);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
});

test('fixture identity registration refuses a closed recovery fence before any identity write', async () => {
  const statements: string[] = [];
  const client = { query: async (sql: string) => {
    statements.push(sql);
    return { rows: [{ open: false }] };
  } } as unknown as PoolClient;
  await expect(registerFixtureIdentity(client, { principalId: randomUUID(), issuer: 'https://account.status.test',
    subject: randomUUID(), actor: native() })).rejects.toBeInstanceOf(FixtureAuthorityDenied);
  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain('recovery_fence');
});

async function fixture(options: {
  hidden?: Partial<EvidenceTarget>;
  hiddenOnSameResource?: boolean;
  scopeKind?: 'component' | 'exact_revision';
  hiddenState?: 'confirmed' | 'pending' | 'failed';
  anonymousRevision?: string;
  targets?: [EvidenceTarget, EvidenceTarget];
  effects?: ModerationEffects;
  effect?: 'search';
} = {}) {
  const principalId = randomUUID();
  const principal = { issuer: 'https://account.status.test', subject: randomUUID() };
  const actor = native();
  const identity = await pool.connect();
  try {
    await identity.query('BEGIN');
    await registerFixtureIdentity(identity, { principalId, ...principal, actor });
    await identity.query('COMMIT');
  } catch (error) {
    await identity.query('ROLLBACK');
    throw error;
  } finally { identity.release(); }
  await grantFixtureAuthority(pool, {
    scope: 'governance:platform', requireDispatch: true,
    representations: [{ principalId, actor, action: 'governance.moderate', lifetime: 'infinity' }],
    grant: { actor, action: 'governance.moderate', lifetime: 'infinity' },
  });
  const a: EvidenceTarget = options.targets?.[0] ?? {
    owner: 'content', resource: native(), component: 'body', revision: native(), locator: null,
  };
  const b: EvidenceTarget = options.targets?.[1] ?? { ...a, resource: options.hiddenOnSameResource ? a.resource : native(),
    revision: options.hiddenOnSameResource ? a.revision : native(), ...options.hidden };
  const rule = { ref: 'urn:rule:status', revision: '1', digest: 'a'.repeat(64) };
  const capture = (target: EvidenceTarget) => ({
    ...target, state: 'available' as const, representation: 'Retained evidence.',
    revisionDigest: 'b'.repeat(64), provenance: {},
  });
  const store = new GovernanceStore(pool, { capture: async (_principal, _actor, target) => capture(target) },
    { current: async target => target.revision ?? [a, b].find(e => e.owner === target.owner
      && e.resource === target.resource && e.component === target.component && e.locator === target.locator)?.revision ?? null },
    { current: async () => rule }, options.effects ?? {
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
    effect: options.effect ?? (e === b && b.locator !== a.locator ? 'search' as const : 'disclosure' as const),
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
    items: [{ ordinal: 1, target: f.a.resource, state: 'confirmed', receipt: expect.stringMatching(/^party:[a-p]{64}$/),
      continuation: null, resumable: false, error: null }],
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
      { ordinal: 1, target: f.b.resource, state: 'confirmed', receipt: expect.stringMatching(/^party:[a-p]{64}$/),
        continuation: null, resumable: false, error: null },
      { ordinal: 2, target: f.a.resource, state: 'confirmed', receipt: expect.stringMatching(/^party:[a-p]{64}$/),
        continuation: null, resumable: false, error: null },
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
      state: 'confirmed', receipt: expect.stringMatching(/^party:[a-p]{64}$/),
      continuation: null, resumable: false, error: null }]);
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

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function contentTarget(): Promise<EvidenceTarget> {
  const resource = native(), author = native(), rootRevision = native();
  const core = new ContentCore(pool);
  const command: SaveDraftCommand = {
    operationId: randomUUID(), variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: resource,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
    expectedHead: null, model: 'member-reply-v1', sourceRevision: rootRevision, provenance: {},
    serializedJson: JSON.stringify({ body: 'Retained reply.', deleted: false, rootTarget: native(), rootRevision }),
  };
  command.provenance = { kind: 'admitted-original-contribution-v1', author, admissionId: randomUUID(),
    authorityEpoch: '0', scope: `content:draft:${resource}`, expectedHead: null,
    rightsBasis: 'original-contribution', requestDigest: contentDraftIntentDigest(command, author) };
  const saved = await core.saveDraft(command);
  return { owner: 'content', resource, component: 'body', revision: saved.revisionId, locator: null };
}

// The graph transport confirms the owner's real receipt; it never manufactures
// a fixture receipt string. Content, Access and media use their real databases.
function receiptGraph(targets: readonly EvidenceTarget[] = []): WorkActivationEnvironment {
  const applied = new Map<string, { digest: string; target: string; head: string }>();
  return { lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() }, fuseki: {
    commandHealth: async () => ({ profiles: Object.fromEntries(Object.entries(profileRegistry)
      .map(([id, profile]) => [id, profile.sha256])) }),
    commandWithReceipt: async (command: { receipt: string; digest: string; update: string }) => {
      const target = command.update.match(/rv:moderationTarget <([^>]+)>/)![1]!;
      const head = command.update.match(/rv:expectedHead <([^>]+)>/)![1]!;
      applied.set(command.receipt, { digest: command.digest, target, head });
      return { status: 'succeeded' };
    },
    query: async (query: string) => {
      if (query.includes('SELECT ?head WHERE')) {
        const selected = targets.find(target => query.includes(`<${target.resource}>`));
        return { results: { bindings: selected ? [{ head: { type: 'uri', value: selected.revision } }] : [] } };
      }
      const row = applied.get(query.match(/<(urn:rezics:receipt:moderation:[^>]+)>/)?.[1] ?? '');
      return { results: { bindings: row ? [{ digest: { value: row.digest },
        target: { value: row.target }, head: { value: row.head } }] : [] } };
    },
  } } as unknown as WorkActivationEnvironment;
}

for (const owner of ['content', 'access', 'graph'] as const) {
  test(`reporter remints production ${owner} receipts without original ordinals or enumerable hashes`, async () => {
    const target = (): EvidenceTarget => ({ owner: owner === 'access' ? 'graph' : owner,
      resource: native(), component: 'body', revision: native(), locator: null });
    const a = owner === 'content' ? await contentTarget() : target();
    const b = owner === 'content' ? await contentTarget() : target();
    const effects = ownerModerationEffects(new ContentModeration(pool), receiptGraph([a, b]));
    const f = await fixture({ targets: [a, b], effects, ...(owner === 'access' ? { effect: 'search' as const } : {}) });
    expect(f.decision.operation.status, JSON.stringify(f.decision.operation)).toBe('completed');
    const ownerReceipt = f.decision.operation.items[1]!.receipt!;
    const operationId = `governance-moderation:${f.decision.decisionId}`;
    // Unregistered graph profiles use an Access enforcement receipt.
    const encodedOrdinal = ownerReceipt.startsWith('urn:rezics:receipt:moderation:')
      ? digest(`${operationId}:2`) : `${operationId}:2`;
    expect(ownerReceipt).toContain(encodedOrdinal);
    const status = await f.reports.status(f.anonymous.caseId, f.anonymous.credential);
    expect(status.operation?.items[0]?.ordinal).toBe(1);
    const receipt = status.operation?.items[0]?.receipt;
    expect(receipt).toMatch(/^party:[a-p]{64}$/);
    expect(receipt).not.toContain('2');
    expect(JSON.stringify(status)).not.toContain(ownerReceipt);
    expect(JSON.stringify(status)).not.toContain(encodedOrdinal);
    for (const concealed of [b.resource, b.revision!]) expect(JSON.stringify(status)).not.toContain(concealed);
    expect((await f.reports.status(f.anonymous.caseId, f.anonymous.credential)).operation).toEqual(status.operation);
    const own = await f.reports.status(f.anonymous.caseId, f.reporter);
    expect(own.operation?.items).toHaveLength(2);
    expect(own.operation?.items[1]?.receipt).not.toBe(receipt);
    expect((await f.store.resumeDecision(f.principal, f.actor, f.decision.decisionId)).operation)
      .toEqual(f.decision.operation);
  });
}

test('production media suppression cursor at a private 100-asset boundary never reaches reporter status', async () => {
  const core = new ContentCore(pool), media = new MediaStore(pool, core);
  const actor = native(), byteDigest = digest(randomUUID());
  const assets: Array<{ reserved: UploadReservation; source: string; state: string }> = [];
  for (let index = 0; index < 101; index++) {
    const reserved = await media.reserveUpload({ admissionId: randomUUID(), principalId: randomUUID(),
      actingSubject: actor, authorityEpoch: '1', requestDigest: digest(randomUUID()) },
    { asset: null, mediaType: 'image/png', byteLength: 64, sha256: byteDigest, disclosure: 'private' });
    const activated = await media.settleUpload(reserved.upload, { status: 'activated', sha256: byteDigest,
      byteLength: 64, mediaType: 'image/png', width: 1, height: 1 }, async () => byteDigest);
    assets.push({ reserved, source: activated.representation, state: (await media.readAsset(reserved.asset))!.state });
  }
  assets.sort((a, b) => a.reserved.asset.localeCompare(b.reserved.asset));
  const visible = assets[0]!, boundary = assets[99]!;
  const target = (asset: typeof visible): EvidenceTarget => ({ owner: 'media',
    resource: `https://rezics.com/id/${asset.reserved.asset}`, component: 'body', revision: asset.state, locator: null });
  const production = ownerModerationEffects(new ContentModeration(pool), receiptGraph(), { pool, core });
  const f = await fixture({ targets: [target(visible), target(boundary)], effects: {
    plan: async (target, _outcome, context) => target.resource === `https://rezics.com/id/${visible.reserved.asset}`
      ? { media: { source: visible.source, state: visible.state, digest: byteDigest }, ncii: true,
        outcome: 'restrict', suppression: { id: copySuppressionId(context!.decisionId, byteDigest),
          caseId: context!.caseId, decisionId: context!.decisionId } } : {},
    apply: (id, ordinal, target, plan, cursor) => production.apply(id, ordinal,
      target.resource === `https://rezics.com/id/${boundary.reserved.asset}` ? { ...target, effect: 'search' } : target,
      plan, cursor),
  } });
  const ownerItem = f.decision.operation.items[1]!;
  expect(ownerItem.receipt, JSON.stringify(f.decision.operation)).toBe(`governance-moderation:${f.decision.decisionId}:2`);
  expect(ownerItem.continuation).toBe(boundary.reserved.asset);
  const status = await f.reports.status(f.anonymous.caseId, f.anonymous.credential);
  expect(status.operation?.status).toBe('partial');
  expect(status.operation?.items[0]).toMatchObject({ ordinal: 1, continuation: null, resumable: true });
  expect(status.operation?.items[0]?.receipt).toMatch(/^party:[a-p]{64}$/);
  expect(Value.Check(publicReportStatus, { profile: CATEGORY_VERSION, ...status })).toBe(true);
  const body = JSON.stringify(status);
  for (const asset of assets.slice(1)) {
    for (const concealed of [asset.reserved.asset, asset.source, asset.state]) expect(body).not.toContain(concealed);
  }
  expect(body).not.toContain(ownerItem.receipt!);
  const resumed = await f.store.resumeDecision(f.principal, f.actor, f.decision.decisionId);
  expect(resumed.operation.status).toBe('completed');
  const completed = await f.reports.status(f.anonymous.caseId, f.anonymous.credential);
  expect(completed.operation?.items[0]).toMatchObject({ continuation: null, resumable: false });
  expect(completed.operation?.items[0]?.receipt).toBe(status.operation?.items[0]?.receipt);
}, 60_000);
