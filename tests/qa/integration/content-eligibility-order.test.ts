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
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { saveAdmittedContentDraft }
  from '../../../services/main/src/modules/content-publication/draft.ts';
import { contentSearchEligibilityDigest, selectPublicContentSearch,
  type ContentSearchEligibilityInput }
  from '../../../services/main/src/modules/content-publication/eligibility.ts';
import { contentPublicationDigest, publishPinnedContent, type PublishPinnedContentInput }
  from '../../../services/main/src/modules/content-publication/publish.ts';
import { ContentProjectionUnavailable, relayContentProjectionOnce }
  from '../../../services/main/src/modules/content-publication/relay.ts';
import { queryPublicContentPhrase }
  from '../../../services/main/src/modules/content-publication/search.ts';
import { activateMetadataWork, DATASET, GRAPHS, metadataWorkRequestDigest, RV }
  from '../../../services/main/src/modules/work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';

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

test('SEARCH19: lagging eligibility stays unavailable and a stale worker cannot replace newer text', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run this test through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `content-eligibility-order-${randomUUID()}`);
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
    const env = { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: join(state, 'objects') };
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const principal = { issuer: 'https://qa-content-order.test', subject: randomUUID() };
    const principalId = randomUUID();
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1,$2)',
      [actor, 'agent']);
    const registry = new AccessAdmissionRegistry(accessPool);
    const account = { verify: async () => principal };
    const title = `SEARCH19 Content eligibility order ${randomUUID()}`;
    const work = await activateMetadataWork(env, { title, admission: {
      id: randomUUID(), scope: 'work:create:root', action: 'work.create',
      idempotencyKey: `order-work-${randomUUID()}`,
      requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } });
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    async function grant(scope: string, action: string) {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), principalId, actor, action]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), actor, scope, action]);
    }
    await grant(`content:draft:${work.work}`, 'content.draft');
    await grant(`content:search-eligibility:${variantId}`, 'content.search-eligibility');
    const draftRequest = new Request('http://main.local/v1/content-drafts', {
      method: 'POST', headers: { authorization: 'Bearer qa' } });
    const marker = `ordermarker${randomUUID().replaceAll('-', '')}`;

    async function draft(label: string, expectedHead: string | null) {
      const input = { resourceId: work.work,
        variant: { id: variantId, resourceId: work.work,
          language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' }, direction: 'ltr' as const },
        expectedHead, body: `${marker} ${label} body ${marker}${label}`, actingSubject: actor,
        idempotencyKey: `order-draft-${randomUUID()}` };
      const result = await saveAdmittedContentDraft(env, content, account, registry, draftRequest, input);
      expect(result.outcome).toBe('succeeded');
      if (!result.revisionId) throw new Error('Content draft revision is absent');
      const exact = (await content.readExactBatch([result.revisionId], async ids => new Set(ids)))[0];
      if (exact?.status !== 'available') throw new Error('Content draft bytes are unavailable');
      return { input, revision: result.revisionId, digest: exact.reference.byteDigest,
        epoch: result.position.dataEpoch, phrase: `${marker}${label}` };
    }
    async function publish(saved: Awaited<ReturnType<typeof draft>>, expectedPublicationHead: string | null) {
      const input: PublishPinnedContentInput = { preparationId: `order-prepare-${randomUUID()}`,
        revisionId: saved.revision, expectedDigest: saved.digest,
        expectedContentEpoch: saved.epoch, resourceId: work.work,
        variantId, expectedPublicationHead };
      const id = randomUUID();
      const admission: RegisteredAdmission = { id, principalId, actingSubject: actor,
        scope: `content:publish:${variantId}`, action: 'content.publish',
        idempotencyKey: `order-publish-${id}`, requestDigest: contentPublicationDigest(input),
        authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString(),
        state: 'claimed', dispatchEligible: true, replayed: false };
      const result = await publishPinnedContent(env, content, admission, input);
      expect(result.status).toBe('active');
      if (!result.decision) throw new Error('Content publication decision is absent');
      return { input, admission, decision: result.decision };
    }
    async function eligible(publicationDecision: string, expectedEligibilityHead: string | null) {
      const input: ContentSearchEligibilityInput = { resourceId: work.work, variantId,
        publicationDecision, expectedEligibilityHead, actingSubject: actor,
        rightsBasis: 'original-contribution', disclosure: 'public' };
      const digest = contentSearchEligibilityDigest(input);
      const registered = await registry.register({ principal, actingSubject: actor,
        scope: `content:search-eligibility:${variantId}`, action: 'content.search-eligibility',
        idempotencyKey: `order-eligibility-${randomUUID()}`, requestDigest: digest });
      const claimed = await registry.claim(registered.id, digest);
      const result = await selectPublicContentSearch(env, content, registry, claimed, input);
      expect(result.outcome).toBe('succeeded');
      if (!result.decision) throw new Error('Content eligibility decision is absent');
      return { input, claimed, decision: result.decision };
    }
    const cursor = new ContentProjectionCursor(pool);
    const consumer = `order-live-${randomUUID()}`;
    await cursor.initialize(consumer);
    async function relayTo(reader: string, relayEnv = env) {
      const dispositions: string[] = [];
      while (BigInt((await cursor.read(reader)).sequence)
        < BigInt((await content.ownerPosition()).sequence)) {
        const result = await relayContentProjectionOnce(relayEnv, content, cursor, reader);
        if (!result) throw new Error('Content projection stopped before owner high water');
        dispositions.push(result.disposition);
      }
      return dispositions;
    }
    const graphSequence = async () => (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?n WHERE {
      GRAPH <${GRAPHS.control}> { <${DATASET}> rv:sequence ?n . } }`)).results?.bindings[0]?.n?.value;
    const units = async () => ((await fuseki.query(`PREFIX rv: <${RV}> SELECT ?unit ?revision WHERE {
      GRAPH <${PUBLIC_SEARCH_GRAPH}> { ?unit a rv:MatchUnit ; rv:variant <${variantId}> ;
        rv:revision ?revision ; rv:projection ?projection . } }`)).results?.bindings ?? [])
      .map(row => [row.unit?.value, row.revision?.value]);
    const app = createMainApp(fuseki, { environment: env, account, access: registry,
      content, contentAuthoring: content, contentProjection: { content, cursor, consumer } });
    const publicQuery = (phrase: string) => app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-content-phrase-v1', phrase, language: 'en' }) }));
    const pageQuery = (phrase: string) => app.handle(new Request('http://main.local/v1/queries/page', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-content-phrase-page-v1', phrase, language: 'en',
        pageSize: 1 }) }));
    async function expectUnavailable(phrases: string[]) {
      for (const phrase of phrases) {
        await expect(queryPublicContentPhrase(env, content, cursor, consumer,
          { phrase, language: 'en' })).rejects.toBeInstanceOf(ContentProjectionUnavailable);
        for (const response of [await publicQuery(phrase), await pageQuery(phrase)]) {
          expect(response.status).toBe(503);
          expect(await response.json()).toMatchObject({ code: 'content_projection_unavailable' });
        }
      }
      expect((await app.handle(new Request('http://main.local/health/search-ready'))).status).toBe(503);
    }

    const v1 = await draft('one', null);
    const p1 = await publish(v1, null);
    const e1 = await eligible(p1.decision, null);
    expect((await relayTo(consumer)).filter(value => value === 'projected')).toHaveLength(1);
    const first = await publicQuery(v1.phrase);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ complete: true, total: 1,
      results: [{ variant: variantId, revision: `urn:rezics:content:revision:${v1.revision}` }] });

    // PostgreSQL commits the replacement body and the graph adopts it before
    // eligibility or MatchUnit projection. Neither the old nor new body is complete.
    const v2 = await draft('two', v1.revision);
    await expectUnavailable([v1.phrase, v2.phrase]);
    const p2 = await publish(v2, p1.decision);
    await expect(relayTo(consumer)).rejects.toThrow('public Content search eligibility is unproven');
    const blockedAt = (await cursor.read(consumer)).sequence;
    await expect(relayContentProjectionOnce(env, content, cursor, consumer))
      .rejects.toBeInstanceOf(ContentProjectionUnavailable);
    expect((await cursor.read(consumer)).sequence).toBe(blockedAt);
    await expectUnavailable([v1.phrase, v2.phrase]);
    expect(await units()).toEqual([[expect.any(String), `urn:rezics:content:revision:${v1.revision}`]]);

    // The eligibility graph event lands after the Content event it names. A
    // stale worker then pauses before its guarded write while v3 becomes the
    // adopted, eligible and projected head through the live worker.
    const e2 = await eligible(p2.decision, e1.decision);
    const stale = `order-stale-${randomUUID()}`;
    await cursor.initialize(stale);
    const events = await content.readOutbox(v1.epoch, '0', 32);
    const v2Active = events.find(event => event.eventType === 'content.publication.active'
      && event.revisionId === v2.revision);
    if (!v2Active) throw new Error('v2 active Content event is absent');
    while (BigInt((await cursor.read(stale)).sequence) + 1n < BigInt(v2Active.position.sequence)) {
      if (!await relayContentProjectionOnce(env, content, cursor, stale)) {
        throw new Error('stale worker stopped before v2');
      }
    }
    let v3: Awaited<ReturnType<typeof draft>> | undefined;
    let interleaved = false;
    const staleFuseki = new Proxy(fuseki, { get(target, property) {
      if (property === 'commandWithReceipt') {
        return async (envelope: Parameters<FusekiClient['commandWithReceipt']>[0]) => {
          if (!interleaved) {
            interleaved = true;
            v3 = await draft('three', v2.revision);
            const p3 = await publish(v3, p2.decision);
            await eligible(p3.decision, e2.decision);
            expect(await relayTo(consumer)).toEqual(expect.arrayContaining(['superseded', 'projected']));
          }
          return target.commandWithReceipt(envelope);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const staleAt = (await cursor.read(stale)).sequence;
    await expect(relayContentProjectionOnce({ ...env, fuseki: staleFuseki }, content, cursor, stale))
      .rejects.toThrow('Content projection command guard-unmatched');
    expect(interleaved).toBe(true);
    if (!v3) throw new Error('v3 was not interleaved');
    expect((await cursor.read(stale)).sequence).toBe(staleAt);
    const current = [[expect.any(String), `urn:rezics:content:revision:${v3.revision}`]];
    expect(await units()).toEqual(current);
    const live = await queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: v3.phrase, language: 'en' });
    expect(live).toMatchObject({ complete: true, total: 1,
      results: [{ revision: `urn:rezics:content:revision:${v3.revision}` }] });
    for (const phrase of [v1.phrase, v2.phrase]) {
      expect(await queryPublicContentPhrase(env, content, cursor, consumer, { phrase, language: 'en' }))
        .toMatchObject({ complete: true, total: 0, results: [] });
    }

    // The stale worker's retry and duplicate replay acknowledge without a write.
    const sequenceBeforeReplay = await graphSequence();
    expect((await relayContentProjectionOnce(env, content, cursor, stale))?.disposition).toBe('superseded');
    expect(await relayTo(stale)).toContain('projected');
    expect(await graphSequence()).toBe(sequenceBeforeReplay);
    expect(await units()).toEqual(current);
    expect(await queryPublicContentPhrase(env, content, cursor, stale,
      { phrase: v3.phrase, language: 'en' })).toMatchObject({ complete: true, total: 1 });

    // Duplicate owner commands replay their receipts and move neither owner.
    const ownerBeforeDuplicates = await content.ownerPosition();
    expect((await saveAdmittedContentDraft(env, content, account, registry, draftRequest,
      v2.input)).replayed).toBe(true);
    expect((await publishPinnedContent(env, content, p2.admission, p2.input)).replayed).toBe(true);
    expect((await selectPublicContentSearch(env, content, registry, e2.claimed, e2.input)).replayed)
      .toBe(true);
    expect(await content.ownerPosition()).toEqual(ownerBeforeDuplicates);
    expect(await graphSequence()).toBe(sequenceBeforeReplay);
    const served = await publicQuery(v3.phrase);
    expect(served.status).toBe(200);
    expect(await served.json()).toMatchObject({ complete: true, total: 1,
      results: [{ revision: `urn:rezics:content:revision:${v3.revision}` }] });
  } finally {
    await accessPool.end();
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 90_000);
