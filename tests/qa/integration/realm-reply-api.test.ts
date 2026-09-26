import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { RealmReplyContentStore } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { RealmReplyStore } from '../../../services/main/src/modules/realm-reply/store.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { activateMetadataWork, ID, metadataWorkRequestDigest }
  from '../../../services/main/src/modules/work/activate.ts';
import { captureContentRecoveryCoverage, graphContentReferences }
  from '../../../services/main/src/modules/work/content-recovery-coverage.ts';

const root = resolve(import.meta.dir, '../../..');
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
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('SUB05/SUB06: exact reviewed revisions place independently in two Realms and revocation suppresses one', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through isolated QA integration');
  }
  const state = join(root, '.temp', `realm-reply-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const contentPool = new Pool({ host: '127.0.0.1', port, user: process.env.USER,
    database: 'postgres', max: 8 });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  try {
    await migrateContent(contentPool);
    const content = new ContentCore(contentPool);
    const owner = new RealmReplyContentStore(contentPool);
    const env = { fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: join(state, 'objects') };
    const author = ID + randomUUID();
    const principal = { issuer: 'https://qa-realm-reply.test', subject: randomUUID() };
    const principalId = randomUUID();
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1,$2)', [author, 'agent']);
    const access = new AccessAdmissionRegistry(accessPool);
    const admitted = (scope: string, action: string, requestDigest: string): RegisteredAdmission => ({
      id: randomUUID(), principalId, actingSubject: author, scope, action,
      idempotencyKey: `fixture-${randomUUID()}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'claimed',
      dispatchEligible: true, replayed: false,
    });
    const title = `Realm reply ${randomUUID()}`;
    const work = await activateMetadataWork(env, { title,
      admission: admitted('work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
    async function realm() {
      const input = { name: `Reply Realm ${randomUUID()}`, actingSubject: author };
      const created = await createRealmSpace(env,
        admitted('space:create:root', 'space.create', spaceCreationDigest(input)), input);
      if (!created.realm) throw new Error('Realm creation failed');
      return created.realm;
    }
    const realmOne = await realm();
    const realmTwo = await realm();
    const reply = ID + randomUUID();
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    async function save(body: string, expectedHead: string | null) {
      const saved = await content.saveDraft({ operationId: randomUUID(), variant: {
        id: variantId, resourceId: reply,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      }, expectedHead, model: 'content-text-v1', sourceRevision: null,
      provenance: { kind: 'qa-realm-reply-fixture' }, serializedJson: JSON.stringify({ body }) });
      if (!saved.revisionId) throw new Error('Content revision was not saved');
      const digest = await contentPool.query<{ byte_digest: string }>(
        'SELECT byte_digest FROM content.revision WHERE id = $1', [saved.revisionId]);
      return { revisionId: saved.revisionId, revisionDigest: digest.rows[0]!.byte_digest };
    }
    const first = await save('first reviewed text', null);
    async function grant(scope: string, action: string) {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), principalId, author, action]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), author, scope, action]);
    }
    await grant(`reply:create:${work.work}`, 'reply.create');
    await grant(`work:read:${work.work}`, 'work.read');
    for (const realmId of [realmOne, realmTwo]) {
      await grant(`review:decide:${realmId}`, 'review.decide');
      await grant(`reply:place:${realmId}`, 'reply.place');
    }
    const store = new RealmReplyStore(owner, content, access, env);
    const app = createMainApp(env.fuseki, { environment: env, access,
      account: { verify: async () => principal }, realmReplies: store });
    async function post(path: string, body: Record<string, unknown>, key = randomUUID()) {
      const response = await app.handle(new Request(`http://main.local${path}`, { method: 'POST',
        headers: { authorization: 'Bearer qa', 'content-type': 'application/json',
          'idempotency-key': key }, body: JSON.stringify(body) }));
      return { status: response.status, body: await response.json() as Record<string, any> };
    }
    async function count(realmId: string) {
      const response = await app.handle(new Request(`http://main.local/v1/realms/${encodeURIComponent(realmId)}`
        + `/reply-roots/${encodeURIComponent(work.work)}/count?actingSubject=${encodeURIComponent(author)}`,
      { headers: { authorization: 'Bearer qa' } }));
      return { status: response.status, body: await response.json() as Record<string, any> };
    }
    async function read(realmId: string, actingSubject = author) {
      const response = await app.handle(new Request(`http://main.local/v1/realms/${encodeURIComponent(realmId)}`
        + `/replies/${encodeURIComponent(reply)}?actingSubject=${encodeURIComponent(actingSubject)}`,
      { headers: { authorization: 'Bearer qa' } }));
      return { status: response.status, body: await response.json() as Record<string, any> };
    }
    const identity = { profile: 'realm-reply-identity-v1', reply, variantId,
      revisionId: first.revisionId, author, rootTarget: work.work,
      rootRevision: work.mainVersion, parentReply: null, parentRevision: null,
      contextRevision: null };
    const identityKey = randomUUID();
    const created = await post('/v1/realm-replies', identity, identityKey);
    expect(created.status).toBe(201);
    expect((await post('/v1/realm-replies', identity, identityKey)).body.replayed).toBe(true);
    const second = await save('second unreviewed text', first.revisionId);
    const reviewOne = { profile: 'realm-reply-review-v1', realm: realmOne, reply,
      revisionId: first.revisionId, revisionDigest: first.revisionDigest,
      expectedGeneration: '0', supersedes: null, outcome: 'approved', method: 'human',
      methodRevision: 'realm-manager-v1', dependencyDigest: sha(work.work),
      reasonReference: null, actingSubject: author };
    const reviewKey = randomUUID();
    const approvedOne = await post('/v1/realm-reply-reviews', reviewOne, reviewKey);
    expect(approvedOne.status).toBe(201);
    expect((await post('/v1/realm-reply-reviews', reviewOne, reviewKey)).body.decisionId)
      .toBe(approvedOne.body.decisionId);
    expect((await post('/v1/realm-reply-reviews', { ...reviewOne, outcome: 'rejected',
      reasonReference: 'changed' }, reviewKey)).status).toBe(409);
    expect((await post('/v1/realm-reply-reviews', { ...reviewOne,
      actingSubject: ID + randomUUID() })).status).toBe(403);
    const unreviewed = await post('/v1/realm-reply-placements', {
      profile: 'realm-reply-placement-v1', realm: realmOne, reply,
      revisionId: second.revisionId, revisionDigest: second.revisionDigest,
      reviewDecisionId: approvedOne.body.decisionId, expectedHead: null, actingSubject: author });
    expect(unreviewed.status).toBe(409);
    expect(await store.visible(realmOne, reply)).toBeNull();
    const placementOne = {
      profile: 'realm-reply-placement-v1', realm: realmOne, reply,
      revisionId: first.revisionId, revisionDigest: first.revisionDigest,
      reviewDecisionId: approvedOne.body.decisionId, expectedHead: null, actingSubject: author };
    const placementKey = randomUUID();
    const placedOne = await post('/v1/realm-reply-placements', placementOne, placementKey);
    expect(placedOne.status, JSON.stringify(placedOne.body)).toBe(201);
    expect((await post('/v1/realm-reply-placements', placementOne, placementKey)).body.placement)
      .toBe(placedOne.body.placement);
    const staleHead = await post('/v1/realm-reply-placements', placementOne);
    expect(staleHead.status).toBe(409);
    const rejectedPin = await contentPool.query<{ status: string }>(`
      SELECT status FROM content.publication_preparation
      WHERE revision_id = $1 AND status = 'rejected'`, [first.revisionId]);
    expect(rejectedPin.rowCount).toBe(1);
    expect((await store.visible(realmOne, reply))?.revisionId).toBe(first.revisionId);
    expect((await count(realmOne)).body).toMatchObject({ count: 1, complete: true });
    expect((await count(realmTwo)).body).toMatchObject({ count: 0, complete: true });
    expect((await read(realmOne)).body.revisionId).toBe(first.revisionId);
    expect((await read(realmOne, ID + randomUUID())).status).toBe(404);
    const approvedTwo = await post('/v1/realm-reply-reviews', { ...reviewOne,
      realm: realmTwo, revisionId: second.revisionId, revisionDigest: second.revisionDigest });
    expect(approvedTwo.status).toBe(201);
    const placedTwo = await post('/v1/realm-reply-placements', {
      profile: 'realm-reply-placement-v1', realm: realmTwo, reply,
      revisionId: second.revisionId, revisionDigest: second.revisionDigest,
      reviewDecisionId: approvedTwo.body.decisionId, expectedHead: null, actingSubject: author });
    expect(placedTwo.status, JSON.stringify(placedTwo.body)).toBe(201);
    expect((await store.visible(realmTwo, reply))?.revisionId).toBe(second.revisionId);
    expect((await count(realmTwo)).body).toMatchObject({ count: 1, complete: true });
    const graphReferences = await graphContentReferences(env.fuseki);
    expect(graphReferences.filter(ref => ref.revisionId === first.revisionId).length).toBeGreaterThan(0);
    expect(graphReferences.filter(ref => ref.revisionId === second.revisionId).length).toBeGreaterThan(0);
    const contentCut = await captureContentRecoveryCoverage(contentPool, graphReferences);
    expect(Number(contentCut.graphReferencesCount)).toBeGreaterThanOrEqual(4);
    const revoked = await post('/v1/realm-reply-reviews', { ...reviewOne,
      expectedGeneration: '1', supersedes: approvedOne.body.decisionId,
      outcome: 'revoked', reasonReference: 'manager-revocation' });
    expect(revoked.status).toBe(201);
    expect(await store.visible(realmOne, reply)).toBeNull();
    expect((await store.visible(realmTwo, reply))?.revisionId).toBe(second.revisionId);
    expect((await read(realmOne)).status).toBe(404);
    expect((await read(realmTwo)).body.revisionId).toBe(second.revisionId);
    expect((await count(realmOne)).body).toMatchObject({ count: 0, complete: true });
    expect((await count(realmTwo)).body).toMatchObject({ count: 1, complete: true });
  } finally {
    await contentPool.end();
    await accessPool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);
