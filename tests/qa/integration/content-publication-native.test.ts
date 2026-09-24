import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { ContentDraftStale, saveAdmittedContentDraft }
  from '../../../services/main/src/modules/content-publication/draft.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { contentSearchEligibilityDigest, selectPublicContentSearch,
  type ContentSearchEligibilityInput } from '../../../services/main/src/modules/content-publication/eligibility.ts';
import { contentPublicationDigest, publishPinnedContent, type PublishPinnedContentInput }
  from '../../../services/main/src/modules/content-publication/publish.ts';
import { ContentProjectionUnavailable, relayContentProjectionOnce }
  from '../../../services/main/src/modules/content-publication/relay.ts';
import { queryPublicContentPhrase } from '../../../services/main/src/modules/content-publication/search.ts';
import { activateMetadataWork, GRAPHS, metadataWorkRequestDigest, RV }
  from '../../../services/main/src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('WORK09/WORK10/SEARCH19: Content CAS and partial native publication with exact search', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run this test through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `content-native-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 8 });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  try {
    await migrateContent(pool);
    const content = new ContentCore(pool);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const lineage = { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH };
    const env = { fuseki, lineage, objectDirectory: join(state, 'objects') };
    const title = `Content publication ${randomUUID()}`;
    const workAdmissionId = randomUUID();
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const created = await activateMetadataWork(env, { title, admission: {
      id: workAdmissionId, scope: 'work:create:root', action: 'work.create',
      idempotencyKey: `content-work-${workAdmissionId}`,
      requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } });
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const principal = { issuer: 'https://qa-content-local.test', subject: randomUUID() };
    const principalId = randomUUID();
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)', [actor, 'agent']);
    const draftScope = `content:draft:${created.work}`;
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [draftScope]);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until) VALUES ($1, $2, $3, 'content.draft', now() + interval '1 hour')`,
    [randomUUID(), principalId, actor]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'content.draft', now() + interval '1 hour')`,
    [randomUUID(), actor, draftScope]);
    const registry = new AccessAdmissionRegistry(accessPool);
    const account = { verify: async () => principal };
    const draftRequest = new Request('http://main.local/v1/content-drafts', {
      method: 'POST', headers: { authorization: 'Bearer qa' } });
    const draftInput = { resourceId: created.work,
      variant: { id: variantId, resourceId: created.work,
        language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' },
        direction: 'ltr' as const }, expectedHead: null,
      body: 'Exact native Content publication', actingSubject: actor,
      idempotencyKey: `draft-${randomUUID()}` };
    const saved = await saveAdmittedContentDraft(env, content, account, registry,
      draftRequest, draftInput);
    expect(saved.outcome).toBe('succeeded');
    expect((await saveAdmittedContentDraft(env, content, account, registry,
      draftRequest, draftInput)).replayed).toBe(true);
    if (!saved.revisionId) throw new Error('Content save has no revision');
    const exact = (await content.readExactBatch([saved.revisionId],
      async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new Error('Content revision is unavailable');
    const input: PublishPinnedContentInput = { preparationId: `publish-${randomUUID()}`,
      revisionId: saved.revisionId, expectedDigest: exact.reference.byteDigest,
      expectedContentEpoch: saved.position.dataEpoch, resourceId: created.work,
      variantId, expectedPublicationHead: null };
    const admissionId = randomUUID();
    const admission: RegisteredAdmission = { id: admissionId, principalId: randomUUID(),
      actingSubject: actor,
      scope: `content:publish:${variantId}`, action: 'content.publish',
      idempotencyKey: `publish-${admissionId}`, requestDigest: contentPublicationDigest(input),
      authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'registered', dispatchEligible: true, replayed: false };
    const first = await publishPinnedContent(env, content, admission, input);
    expect(first.status).toBe('active');
    expect(first.replayed).toBe(false);
    expect(first.decision).toBeTruthy();
    expect(first.graphDataEpoch).toBe(lineage.dataEpoch);
    const preparation = await content.readPublicationPreparation(input.preparationId);
    expect(preparation?.status).toBe('active');
    expect(preparation?.pinActive).toBe(true);
    expect(preparation?.reference.revisionId).toBe(saved.revisionId);
    const graph = await fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH <${GRAPHS.current}> {
        <${variantId}> rv:contentPublicationHead <${first.decision}> . }
      GRAPH <${GRAPHS.revisions}> {
        <${first.decision}> rv:contentRevision <urn:rezics:content:revision:${saved.revisionId}> ;
          rv:byteDigest ${JSON.stringify(input.expectedDigest)} ;
          rv:ownerDataEpoch ${JSON.stringify(input.expectedContentEpoch)} . }
    }`);
    expect(graph.boolean).toBe(true);
    const replay = await publishPinnedContent(env, content, admission, input);
    expect(replay.status).toBe('active');
    expect(replay.replayed).toBe(true);
    expect(replay.graphSequence).toBe(first.graphSequence);

    const cursor = new ContentProjectionCursor(pool);
    const consumer = `content-native-${randomUUID()}`;
    expect((await cursor.initialize(consumer)).sequence).toBe('0');
    const events = await content.readOutbox(saved.position.dataEpoch, '0', 10);
    expect(events.map(event => event.eventType)).toEqual([
      'content.revision.saved', 'content.publication.prepared', 'content.publication.active',
    ]);
    expect((await relayContentProjectionOnce(env, content, cursor, consumer))?.disposition).toBe('ignored');
    expect((await relayContentProjectionOnce(env, content, cursor, consumer))?.disposition).toBe('ignored');
    await expect(relayContentProjectionOnce(env, content, cursor, consumer))
      .rejects.toBeInstanceOf(ContentProjectionUnavailable);
    expect((await cursor.read(consumer)).sequence).toBe('2');
    await expect(queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: 'native Content', language: 'en' })).rejects.toBeInstanceOf(ContentProjectionUnavailable);

    const eligibilityInput: ContentSearchEligibilityInput = { resourceId: created.work,
      variantId, publicationDecision: first.decision!, expectedEligibilityHead: null,
      actingSubject: actor, rightsBasis: 'original-contribution', disclosure: 'public' };
    const eligibilityScope = `content:search-eligibility:${variantId}`;
    const action = 'content.search-eligibility';
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [eligibilityScope]);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
    [randomUUID(), principalId, actor, action]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
    [randomUUID(), actor, eligibilityScope, action]);
    const eligibilityDigest = contentSearchEligibilityDigest(eligibilityInput);
    const registered = await registry.register({ principal, actingSubject: actor,
      scope: eligibilityScope, action, idempotencyKey: `eligibility-${randomUUID()}`,
      requestDigest: eligibilityDigest });
    const claimed = await registry.claim(registered.id, eligibilityDigest);
    const eligibility = await selectPublicContentSearch(env, content, registry, claimed, eligibilityInput);
    expect(eligibility.outcome).toBe('succeeded');
    expect(eligibility.decision).toBeTruthy();
    expect((await selectPublicContentSearch(env, content, registry, claimed, eligibilityInput)).replayed).toBe(true);
    const projected = await relayContentProjectionOnce(env, content, cursor, consumer);
    expect(projected?.disposition).toBe('projected');
    expect(projected?.sourceSequence).toBe(events[2]!.position.sequence);
    expect((await cursor.read(consumer)).sequence).toBe(events[2]!.position.sequence);
    const phrase = await queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: 'native Content', language: 'en' });
    expect(phrase.complete).toBe(true);
    expect(phrase.total).toBe(1);
    expect(phrase.results[0]).toMatchObject({ variant: variantId,
      revision: `urn:rezics:content:revision:${saved.revisionId}`,
      publicationDecision: first.decision });
    const app = createMainApp(fuseki, { environment: env,
      account, access: registry, content, contentAuthoring: content,
      contentProjection: { content, cursor, consumer } });
    const authoredReplay = await app.handle(new Request('http://main.local/v1/content-drafts', {
      method: 'POST', headers: { 'content-type': 'application/json',
        authorization: 'Bearer qa', 'idempotency-key': draftInput.idempotencyKey },
      body: JSON.stringify({ profile: 'content-text-v1', resourceId: created.work,
        variantId, language: draftInput.variant.language, direction: 'ltr',
        expectedHead: null, body: draftInput.body, actingSubject: actor }),
    }));
    expect(authoredReplay.status).toBe(200);
    expect(await authoredReplay.json()).toMatchObject({ revisionId: saved.revisionId,
      replayed: true });
    const ready = await app.handle(new Request('http://main.local/health/search-ready'));
    expect(ready.status).toBe(200);
    const response = await app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-content-phrase-v1',
        phrase: 'native Content', language: 'en' }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ profile: 'public-content-phrase-v1',
      resultGrain: 'content-variant', complete: true, total: 1,
      results: [{ variant: variantId,
        revision: `urn:rezics:content:revision:${saved.revisionId}` }] });

    const editKeys = [`edit-${randomUUID()}`, `edit-${randomUUID()}`];
    const edits = ['Competing Content edit A', 'Competing Content edit B'].map((body, index) => ({
      ...draftInput, expectedHead: saved.revisionId!, body, idempotencyKey: editKeys[index]!,
    }));
    const raced = await Promise.allSettled(edits.map(input => saveAdmittedContentDraft(env,
      content, account, registry, draftRequest, input)));
    const winners = raced.flatMap((result, index) => result.status === 'fulfilled'
      ? [{ index, value: result.value }] : []);
    const losers = raced.filter(result => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ reason: expect.any(ContentDraftStale) });
    const winner = winners[0]!;
    expect(winner.value.outcome).toBe('succeeded');
    expect(winner.value.revisionId).toBeTruthy();
    expect((await saveAdmittedContentDraft(env, content, account, registry,
      draftRequest, edits[winner.index]!)).replayed).toBe(true);
    await expect(saveAdmittedContentDraft(env, content, account, registry, draftRequest,
      edits[1 - winner.index]!)).rejects.toBeInstanceOf(ContentDraftStale);

    const head = await pool.query<{ draft_head: string }>(
      'SELECT draft_head FROM content.variant WHERE id = $1', [variantId]);
    expect(head.rows[0]?.draft_head).toBe(winner.value.revisionId);
    const revisions = await pool.query<{ id: string; predecessor: string | null }>(
      'SELECT id, predecessor FROM content.revision WHERE variant_id = $1 ORDER BY created_at', [variantId]);
    expect(revisions.rows).toHaveLength(2);
    expect(revisions.rows).toEqual(expect.arrayContaining([
      { id: saved.revisionId, predecessor: null },
      { id: winner.value.revisionId, predecessor: saved.revisionId },
    ]));
    const admissions = await accessPool.query<{ id: string; idempotency_key: string;
      state: string; graph_outcome: string }>(`SELECT id, idempotency_key, state, graph_outcome
      FROM access.admission WHERE idempotency_key = ANY($1::text[])`, [editKeys]);
    expect(admissions.rows).toHaveLength(2);
    expect(admissions.rows.every(row => row.state === 'sealed')).toBe(true);
    expect(admissions.rows.map(row => row.graph_outcome).sort()).toEqual(['cancelled', 'succeeded']);
    const receipts = await pool.query<{ operation_id: string; outcome: string;
      revision_id: string | null; sequence: string }>(`SELECT operation_id, outcome,
      revision_id, sequence::text FROM content.receipt WHERE operation_id = ANY($1::text[])`,
    [admissions.rows.map(row => `content-draft:${row.id}`)]);
    expect(receipts.rows).toHaveLength(2);
    const receiptByKey = new Map(admissions.rows.map(admission => [admission.idempotency_key,
      receipts.rows.find(receipt => receipt.operation_id === `content-draft:${admission.id}`)]));
    expect(receiptByKey.get(editKeys[winner.index]!)?.outcome).toBe('succeeded');
    expect(receiptByKey.get(editKeys[winner.index]!)?.revision_id).toBe(winner.value.revisionId);
    expect(receiptByKey.get(editKeys[1 - winner.index]!)?.outcome).toBe('stale_head');
    expect(receiptByKey.get(editKeys[1 - winner.index]!)?.revision_id).toBeNull();
    const outbox = await pool.query<{ operation_id: string; event_type: string;
      sequence: string }>(`SELECT operation_id, event_type, sequence::text FROM content.outbox
      WHERE operation_id = ANY($1::text[])`, [receipts.rows.map(row => row.operation_id)]);
    expect(outbox.rows).toHaveLength(2);
    expect(new Set(outbox.rows.map(row => row.sequence))).toEqual(
      new Set(receipts.rows.map(row => row.sequence)));
    expect(outbox.rows.map(row => row.event_type).sort()).toEqual([
      'content.draft.stale', 'content.revision.saved',
    ]);

    const readScope = `work:read:${created.work}`;
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [readScope]);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.read', now() + interval '1 hour')`,
    [randomUUID(), principalId, actor]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'work.read', now() + interval '1 hour')`,
    [randomUUID(), actor, readScope]);
    const readRevision = (revisionId: string) => app.handle(new Request(
      `http://main.local/v1/content-revisions/${revisionId}?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: 'Bearer qa' } }));
    const oldRevision = await readRevision(saved.revisionId);
    expect(oldRevision.status).toBe(200);
    expect(await oldRevision.json()).toMatchObject({
      reference: { owner: 'content', revisionId: saved.revisionId, variantId },
      body: { body: draftInput.body },
    });
    const newRevision = await readRevision(winner.value.revisionId!);
    expect(newRevision.status).toBe(200);
    expect(await newRevision.json()).toMatchObject({
      reference: { owner: 'content', revisionId: winner.value.revisionId, variantId },
      body: { body: edits[winner.index]!.body },
    });
    expect((await relayContentProjectionOnce(env, content, cursor, consumer))?.disposition).toBe('ignored');
    expect((await relayContentProjectionOnce(env, content, cursor, consumer))?.disposition).toBe('ignored');
    const selectedAfterDraftEdit = await queryPublicContentPhrase(env, content, cursor,
      consumer, { phrase: 'native Content', language: 'en' });
    expect(selectedAfterDraftEdit.results[0]?.revision)
      .toBe(`urn:rezics:content:revision:${saved.revisionId}`);
  } finally {
    await accessPool.end();
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 60_000);
