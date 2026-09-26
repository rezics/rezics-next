import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import type { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { RealmReplyContentStore } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { engageAccessRecoveryFence }
  from '../../../services/main/src/modules/access/admission.ts';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { assertContentRecoveryCoverage, captureContentRecoveryCoverage }
  from '../../../services/main/src/modules/work/content-recovery-coverage.ts';
import { accessOutboxCoverage, accessStateCoverage, releaseRestoredGraphHold,
  type RecoveryCoverage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';

const root = resolve(import.meta.dir, '../../..');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('SUB08: a pre-revocation Content restore cannot pass the retained review cut', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through isolated QA fault recovery');
  const state = join(root, '.temp', `realm-restore-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const poolFor = (database: string) => new Pool({ host: '127.0.0.1', port,
    user: process.env.USER, database, max: 4 });
  let live = poolFor('postgres');
  let restored: Pool | undefined;
  try {
    await migrateContent(live);
    const content = new ContentCore(live);
    const owner = new RealmReplyContentStore(live);
    const reply = `https://rezics.com/id/${randomUUID()}`;
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const rootTarget = `https://rezics.com/id/${randomUUID()}`;
    const realm = `https://rezics.com/id/${randomUUID()}`;
    const saved = await content.saveDraft({ operationId: randomUUID(), variant: {
      id: variantId, resourceId: reply,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
    }, expectedHead: null, model: 'content-text-v1', sourceRevision: null,
    provenance: { kind: 'qa-realm-reply-restore' },
    serializedJson: JSON.stringify({ body: 'approved before restore' }) });
    if (!saved.revisionId) throw new Error('missing revision');
    const revisionDigest = (await live.query<{ byte_digest: string }>(
      'SELECT byte_digest FROM content.revision WHERE id = $1', [saved.revisionId])).rows[0]!.byte_digest;
    const admission = (action: string, scope: string): RegisteredAdmission => ({
      id: randomUUID(), principalId: randomUUID(), actingSubject: actor,
      action, scope, idempotencyKey: randomUUID(), requestDigest: sha(randomUUID()),
      authorityEpoch: '1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false,
    });
    await owner.createReply(admission('reply.create', `reply:create:${rootTarget}`), {
      reply, variantId, revisionId: saved.revisionId, author: actor,
      rootTarget, rootRevision: 'root-revision-1', parentReply: null,
      parentRevision: null, contextRevision: null });
    const approved = await owner.decideReview(admission('review.decide', `review:decide:${realm}`), {
      realm, reply, revisionId: saved.revisionId, revisionDigest,
      expectedGeneration: '0', supersedes: null, outcome: 'approved',
      method: 'human', methodRevision: 'realm-manager-v1',
      dependencyDigest: sha(rootTarget), reasonReference: null });
    const prepared = await owner.preparePlacement(admission('reply.place', `reply:place:${realm}`), {
      realm, reply, revisionId: saved.revisionId, revisionDigest,
      reviewDecisionId: approved.decisionId, expectedHead: null });
    await content.settlePublication(randomUUID(), prepared.operationId, {
      outcome: 'active', revisionId: saved.revisionId,
      receipt: `urn:rezics:receipt:${sha(prepared.operationId)}`,
      dataEpoch: randomUUID(), sequence: '1' });
    expect(await owner.currentReview(realm, reply, saved.revisionId, approved.decisionId)).toBe(true);

    // A stopped template copy is the candidate restore from before revocation.
    await live.end();
    const admin = poolFor('template1');
    await admin.query('CREATE DATABASE pre_revocation WITH TEMPLATE postgres');
    await admin.end();
    live = poolFor('postgres');
    restored = poolFor('pre_revocation');
    const liveOwner = new RealmReplyContentStore(live);
    await liveOwner.decideReview(admission('review.decide', `review:decide:${realm}`), {
      realm, reply, revisionId: saved.revisionId, revisionDigest,
      expectedGeneration: '1', supersedes: approved.decisionId, outcome: 'revoked',
      method: 'human', methodRevision: 'realm-manager-v1',
      dependencyDigest: sha(rootTarget), reasonReference: 'revoked-after-cut' });
    expect(await liveOwner.currentReview(realm, reply, saved.revisionId, approved.decisionId)).toBe(false);
    const oldOwner = new RealmReplyContentStore(restored);
    expect(await oldOwner.currentReview(realm, reply, saved.revisionId, approved.decisionId)).toBe(true);

    const retained = await captureContentRecoveryCoverage(live, []);
    const emptyGraph = { query: async () => ({ results: { bindings: [] } }) } as unknown as FusekiClient;
    await expect(assertContentRecoveryCoverage(restored, emptyGraph, retained))
      .rejects.toThrow('restored Content owner differs from captured cut');
    await assertContentRecoveryCoverage(live, emptyGraph, retained);
  } finally {
    await live.end();
    if (restored) await restored.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);

test('SUB08: an older gift restore differs from the retained Commerce revocation cut', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through isolated QA fault recovery');
  const { cloneQaAccountAccessDatabases } = await import('../support/databases.ts');
  const { readEnv } = await import('../../../scripts/dev/config.ts');
  const { CommerceStore, commerceIntentDigest, giftScope, GIFT_ACTION, SUBSCRIBE_ACTION } =
    await import('../../../services/main/src/modules/commerce/store.ts');
  const { captureCommerceRecoveryCoverage, assertCommerceRecoveryCoverage } =
    await import('../../../services/main/src/modules/commerce/recovery-coverage.ts');
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID);
  const stack = join(root, '.temp', 'stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`);
  const compose = readEnv(join(stack, 'compose.env'));
  const admin = new Pool({ connectionString:
    `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres` });
  const oldName = `qa_gift_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let live = new Pool({ connectionString: databases.urls.access });
  let old: Pool | undefined;
  try {
    const seller = `https://rezics.com/id/${randomUUID()}`;
    const beneficiary = `https://rezics.com/id/${randomUUID()}`;
    const issuerAgent = `https://rezics.com/id/${randomUUID()}`;
    const principal = { issuer: 'https://qa-gift-restore.test', subject: randomUUID() };
    const principalId = randomUUID();
    const offering = randomUUID();
    await live.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, principal.issuer, principal.subject]);
    await live.query(`INSERT INTO access.authority_subject (id, kind) VALUES
      ($1, 'agent'), ($2, 'institution')`, [beneficiary, issuerAgent]);
    await live.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until) VALUES
      ($1,$2,$3,$4,now() + interval '1 hour'),
      ($5,$2,$6,$7,now() + interval '1 hour')`,
    [randomUUID(), principalId, beneficiary, SUBSCRIBE_ACTION,
      randomUUID(), issuerAgent, GIFT_ACTION]);
    await live.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [giftScope(seller)]);
    await live.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
    [randomUUID(), issuerAgent, giftScope(seller), GIFT_ACTION]);
    const offeringClient = await live.connect();
    try {
      await offeringClient.query('BEGIN');
    await offeringClient.query(`INSERT INTO commerce.offering (id, seller, beneficiary_kind, head_revision)
      VALUES ($1,$2,'person',1)`, [offering, seller]);
    await offeringClient.query(`INSERT INTO commerce.offering_revision
      (offering_id, revision, lifecycle, definition_digest)
      VALUES ($1,1,'open',repeat('a',64))`, [offering]);
    await offeringClient.query(`INSERT INTO commerce.plan_group (offering_id, group_key, semantics)
      VALUES ($1,'pro','replaceable')`, [offering]);
    await offeringClient.query(`INSERT INTO commerce.plan
      (offering_id, offering_revision, plan_key, group_key, rank)
      VALUES ($1,1,'plus','pro',2)`, [offering]);
    await offeringClient.query(`INSERT INTO commerce.plan_benefit
      (offering_id, offering_revision, plan_key, benefit_key, level)
      VALUES ($1,1,'plus','pro.read',2)`, [offering]);
      await offeringClient.query('COMMIT');
    } catch (error) { await offeringClient.query('ROLLBACK'); throw error; }
    finally { offeringClient.release(); }
    const store = () => new CommerceStore(live, {
      create: async () => {}, lookup: async () => 'not-found' as const,
    }, () => undefined);
    const issue = { operation: 'issue' as const, issuerSubject: issuerAgent,
      beneficiary, offeringId: offering, offeringRevision: '1', planKey: 'plus',
      validUntil: new Date(Date.now() + 60 * 60_000).toISOString(), reason: 'test-award' };
    const gift = await store().gift(principal, issue,
      { idempotencyKey: randomUUID(), requestDigest: commerceIntentDigest(issue) });
    expect(gift.state).toBe('active');
    expect((await store().benefits(principal, beneficiary)).benefits.length).toBe(1);
    await live.end();
    const source = new URL(databases.urls.access).pathname.slice(1);
    await admin.query(`CREATE DATABASE ${oldName} WITH TEMPLATE ${source} OWNER access`);
    live = new Pool({ connectionString: databases.urls.access });
    const oldUrl = new URL(databases.urls.access);
    oldUrl.pathname = `/${oldName}`;
    old = new Pool({ connectionString: oldUrl.toString() });
    const revoke = { operation: 'revoke' as const, issuerSubject: issuerAgent,
      entitlementId: gift.entitlementId, expectedGeneration: '1', reason: 'test-withdrawal' };
    await store().gift(principal, revoke,
      { idempotencyKey: randomUUID(), requestDigest: commerceIntentDigest(revoke) });
    expect((await store().benefits(principal, beneficiary)).benefits).toEqual([]);
    const retained = await captureCommerceRecoveryCoverage(live);
    const oldStore = new CommerceStore(old, { create: async () => {},
      lookup: async () => 'not-found' as const }, () => undefined);
    expect((await oldStore.benefits(principal, beneficiary)).benefits.length).toBe(1);
    await expect(assertCommerceRecoveryCoverage(old, retained))
      .rejects.toThrow('restored Commerce owner differs from retained cut');
    await assertCommerceRecoveryCoverage(live, retained);

    // The global release must reject this same old Access snapshot before it
    // probes Account, relay or Jena. Commerce is the only changed owner here.
    await engageAccessRecoveryFence(old);
    const [outbox, accessState] = await Promise.all([
      accessOutboxCoverage(old), accessStateCoverage(old),
    ]);
    const priorDataEpoch = randomUUID();
    const coverage: RecoveryCoverage = {
      priorDataEpoch, priorSequence: '0',
      accountPg: { systemIdentifier: '1', flushedLsn: '0/0', walFile: '0'.repeat(24) },
      account: { rowCount: '0', rowDigest: '0'.repeat(64) },
      accessOutboxCount: outbox.count, accessOutboxDigest: outbox.digest,
      accessStateCount: accessState.count, accessStateDigest: accessState.digest,
      relay: { consumer: 'gift-restore', dataEpoch: priorDataEpoch,
        sequence: '0', batchCount: '0', batchDigest: '0'.repeat(64),
        eventCount: '0', eventDigest: '0'.repeat(64) },
      commerce: retained,
    };
    const hmacKey = 'cd'.repeat(32);
    const sealedCoverage = JSON.stringify(sealRecoveryPayload(
      coverage, hmacKey, 'graph-recovery-coverage'));
    const untouchedGraph = ({ query: async () => { throw new Error('graph release was reached'); },
      commandWithReceipt: async () => { throw new Error('graph release was reached'); } }) as unknown as FusekiClient;
    const release = (saved: string) => releaseRestoredGraphHold(untouchedGraph, old!, old!,
      { dataEpoch: randomUUID(), routingEpoch: '2' },
      { sealedCoverage: saved, hmacKey, accountPool: old! });
    await expect(release(sealedCoverage))
      .rejects.toThrow('Commerce owner differs from recovery coverage');
    const { commerce: _omitted, ...withoutCommerce } = coverage;
    await expect(release(JSON.stringify(sealRecoveryPayload(
      withoutCommerce, hmacKey, 'graph-recovery-coverage'))))
      .rejects.toThrow('invalid recovery coverage');
  } finally {
    await live.end();
    if (old) await old.end();
    await admin.query(`DROP DATABASE IF EXISTS ${oldName} WITH (FORCE)`);
    await admin.end();
    await databases.close();
  }
}, 180_000);
