import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { ContentCore, contentDraftIntentDigest, type SaveDraftCommand } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { RealmReplyContentStore } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { RealmReplyStore } from '../../../services/main/src/modules/realm-reply/store.ts';
import { readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { activateMetadataWork, GRAPHS, ID, iri, metadataWorkRequestDigest, RV }
  from '../../../services/main/src/modules/work/activate.ts';
import { captureContentRecoveryCoverage, graphContentReferences }
  from '../../../services/main/src/modules/work/content-recovery-coverage.ts';

const root = resolve(import.meta.dir, '../../..');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('SUB05/SUB06: exact reviewed revisions place independently in two Realms and revocation suppresses one', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.CONTENT_DATABASE_URL || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through isolated QA integration');
  }
  const state = join(root, '.temp', `realm-reply-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const stack = join(root, '.temp', 'stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`);
  const compose = readEnv(join(stack, 'compose.env'));
  const adminUrl = `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres`;
  const database = `qa_realm_reply_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${database} WITH TEMPLATE template0 OWNER content`); }
  finally { await admin.end(); }
  const contentUrl = new URL(Bun.env.CONTENT_DATABASE_URL);
  contentUrl.pathname = `/${database}`;
  const contentPool = new Pool({ connectionString: contentUrl.toString(), max: 8 });
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
      const command: SaveDraftCommand = { operationId: randomUUID(), variant: {
        id: variantId, resourceId: reply,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      }, expectedHead, model: 'member-reply-v1', sourceRevision: work.mainVersion,
      provenance: {}, serializedJson: JSON.stringify({ body, deleted: false,
        rootTarget: work.work, rootRevision: work.mainVersion }) };
      command.provenance = { kind: 'admitted-original-contribution-v1', author,
        admissionId: randomUUID(), authorityEpoch: '0', scope: `content:draft:${reply}`,
        expectedHead, rightsBasis: 'original-contribution', requestDigest: contentDraftIntentDigest(command, author) };
      const saved = await content.saveDraft(command);
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
    async function placementEvent(placement: string) {
      const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt ?event ?batch ?sequence WHERE {
        GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:placement ${iri(placement)} ; rv:sequence ?sequence }
        GRAPH ${iri(GRAPHS.outbox)} { ?event a rv:RealmReplyPlacedEvent ; rv:receipt ?receipt .
          ?batch a rv:OutboxBatch ; rv:event ?event }
      } LIMIT 2`)).results?.bindings ?? [];
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      return readMainOutboxEnvelope(env.fuseki, { batchId: row.batch!.value,
        dataEpoch: env.lineage.dataEpoch, routingEpoch: env.lineage.routingEpoch,
        sequence: row.sequence!.value, eventIds: [row.event!.value] }, row.event!.value);
    }
    const firstEvent = await placementEvent(placedOne.body.placement);
    expect(firstEvent.type).toBe('com.rezics.realm.reply-placed.v1');
    expect(firstEvent.data.receipt).toMatchObject({ realm: realmOne, reply,
      placement: placedOne.body.placement, contentRevision: `urn:rezics:content:revision:${first.revisionId}`,
      byteDigest: first.revisionDigest, reviewDecision: `urn:rezics:realm-review:${approvedOne.body.decisionId}` });
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
    const contentRevision = 'https://rezics.com/vocab/contentRevision';
    expect(graphReferences.filter(ref => ref.predicate === contentRevision
      && ref.object === `urn:rezics:content:revision:${first.revisionId}`).length).toBeGreaterThan(0);
    expect(graphReferences.filter(ref => ref.predicate === contentRevision
      && ref.object === `urn:rezics:content:revision:${second.revisionId}`).length).toBeGreaterThan(0);
    const contentCut = await captureContentRecoveryCoverage(contentPool, graphReferences);
    expect(Number(contentCut.graphReferencesCount)).toBeGreaterThanOrEqual(4);
    const replacement = await post('/v1/realm-reply-placements', {
      ...placementOne, expectedHead: placedOne.body.placement });
    expect(replacement.status, JSON.stringify(replacement.body)).toBe(201);
    expect((await placementEvent(replacement.body.placement)).data.receipt)
      .toMatchObject({ expectedHead: placedOne.body.placement });
    expect(await placementEvent(placedOne.body.placement)).toEqual(firstEvent);
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
    expect(await placementEvent(placedOne.body.placement)).toEqual(firstEvent);
  } finally {
    await contentPool.end();
    await accessPool.end();
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    try { await cleanup.query(`DROP DATABASE ${database} WITH (FORCE)`); }
    finally { await cleanup.end(); }
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);
