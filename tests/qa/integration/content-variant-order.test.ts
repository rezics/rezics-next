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
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { saveAdmittedContentDraft }
  from '../../../services/main/src/modules/content-publication/draft.ts';
import { contentSearchEligibilityDigest, selectPublicContentSearch,
  type ContentSearchEligibilityInput }
  from '../../../services/main/src/modules/content-publication/eligibility.ts';
import { contentPublicationDigest, publishPinnedContent, reconcilePinnedContentPublication,
  type PublishPinnedContentInput }
  from '../../../services/main/src/modules/content-publication/publish.ts';
import { ContentProjectionUnavailable, relayContentProjectionOnce }
  from '../../../services/main/src/modules/content-publication/relay.ts';
import { queryPublicContentPhrase }
  from '../../../services/main/src/modules/content-publication/search.ts';
import { createRealmSpace, spaceCreationDigest }
  from '../../../services/main/src/modules/space/create.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { activateMetadataWork, DATASET, GRAPHS, metadataWorkRequestDigest, RV }
  from '../../../services/main/src/modules/work/activate.ts';
import { selectRealmLocal, realmSelectionDigest }
  from '../../../services/main/src/modules/work/select-realm.ts';

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

/** Keep the real graph command and receipt; interrupt only cross-owner settlement. */
function interruptSettlement(content: ContentCore): ContentCore {
  return new Proxy(content, { get(target, property) {
    if (property === 'settlePublication') return () => {
      throw new Error('simulated settlement interruption');
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

test('SEARCH19: same-language variants survive reversed owner settlement, replay and sparse Realms', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run this test through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `content-variant-order-${randomUUID()}`);
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
    const principal = { issuer: 'https://qa-content-variants.test', subject: randomUUID() };
    const principalId = randomUUID();
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1,$2)',
      [actor, 'agent']);
    const registry = new AccessAdmissionRegistry(accessPool);
    const account = { verify: async () => principal };
    const title = `SEARCH19 Content variants ${randomUUID()}`;
    const work = await activateMetadataWork(env, { title, admission: {
      id: randomUUID(), scope: 'work:create:root', action: 'work.create',
      idempotencyKey: `variant-work-${randomUUID()}`,
      requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } });

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
    const draftRequest = new Request('http://main.local/v1/content-drafts', {
      method: 'POST', headers: { authorization: 'Bearer qa' } });
    const marker = `variantmarker${randomUUID().replaceAll('-', '')}`;
    const variants = [0, 1].map(index => ({
      id: `urn:rezics:variant:${randomUUID()}`,
      body: `${marker} independent English body ${index === 0 ? 'amber' : 'blue'}`,
      unique: index === 0 ? 'amber' : 'blue',
    }));
    const saved = [] as Array<{ id: string; body: string; unique: string;
      revision: string; digest: string; epoch: string }>;
    for (const variant of variants) {
      const result = await saveAdmittedContentDraft(env, content, account, registry,
        draftRequest, { resourceId: work.work,
          variant: { id: variant.id, resourceId: work.work,
            language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
          expectedHead: null, body: variant.body, actingSubject: actor,
          idempotencyKey: `variant-draft-${randomUUID()}` });
      expect(result.outcome).toBe('succeeded');
      if (!result.revisionId) throw new Error('variant draft revision is absent');
      const exact = (await content.readExactBatch([result.revisionId],
        async ids => new Set(ids)))[0];
      if (exact?.status !== 'available') throw new Error('variant exact bytes are unavailable');
      saved.push({ id: variant.id, body: variant.body, unique: variant.unique,
        revision: result.revisionId, digest: exact.reference.byteDigest,
        epoch: result.position.dataEpoch });
    }
    expect(new Set(saved.map(item => item.revision)).size).toBe(2);
    const publication = saved.map(item => ({ item,
      input: { preparationId: `variant-prepare-${randomUUID()}`,
        revisionId: item.revision, expectedDigest: item.digest,
        expectedContentEpoch: item.epoch, resourceId: work.work,
        variantId: item.id, expectedPublicationHead: null } satisfies PublishPinnedContentInput }));
    function publishAdmission(input: PublishPinnedContentInput): RegisteredAdmission {
      const id = randomUUID();
      return { id, principalId, actingSubject: actor, scope: `content:publish:${input.variantId}`,
        action: 'content.publish', idempotencyKey: `variant-publish-${id}`,
        requestDigest: contentPublicationDigest(input), authorityEpoch: '0',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        state: 'claimed', dispatchEligible: true, replayed: false };
    }
    const admissions = publication.map(({ input }) => publishAdmission(input));
    // A graph receipt commits first, but its Content settlement is delayed until
    // after B settles. Thus graph and Content outboxes report opposite order.
    await expect(publishPinnedContent(env, interruptSettlement(content),
      admissions[0]!, publication[0]!.input)).rejects.toThrow('simulated settlement interruption');
    expect((await content.readPublicationPreparation(publication[0]!.input.preparationId))?.status)
      .toBe('pending');
    const b = await publishPinnedContent(env, content, admissions[1]!, publication[1]!.input);
    expect(b.status).toBe('active');
    const a = await reconcilePinnedContentPublication(env, content,
      admissions[0]!, publication[0]!.input);
    expect(a.status).toBe('active');
    expect(a.decision).toBeTruthy();
    expect(b.decision).toBeTruthy();
    expect(BigInt(a.graphSequence!) < BigInt(b.graphSequence!)).toBe(true);

    for (const [index, current] of publication.entries()) {
      const item = current.item;
      const decision = index === 0 ? a.decision! : b.decision!;
      const input: ContentSearchEligibilityInput = { resourceId: work.work,
        variantId: item.id, publicationDecision: decision,
        expectedEligibilityHead: null, actingSubject: actor,
        rightsBasis: 'original-contribution', disclosure: 'public' };
      const scope = `content:search-eligibility:${item.id}`;
      await grant(scope, 'content.search-eligibility');
      const digest = contentSearchEligibilityDigest(input);
      const registered = await registry.register({ principal, actingSubject: actor,
        scope, action: 'content.search-eligibility',
        idempotencyKey: `variant-eligibility-${randomUUID()}`, requestDigest: digest });
      const claimed = await registry.claim(registered.id, digest);
      const eligible = await selectPublicContentSearch(env, content, registry, claimed, input);
      expect(eligible.outcome).toBe('succeeded');
      expect(eligible.decision).toBeTruthy();
    }

    const events = await content.readOutbox(saved[0]!.epoch, '0', 16);
    const active = events.filter(event => event.eventType === 'content.publication.active');
    expect(active).toHaveLength(2);
    expect(active.map(event => event.revisionId)).toEqual([saved[1]!.revision, saved[0]!.revision]);
    const cursor = new ContentProjectionCursor(pool);
    const consumer = `variant-live-${randomUUID()}`;
    await cursor.initialize(consumer);
    await expect(queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: marker, language: 'en' })).rejects.toBeInstanceOf(ContentProjectionUnavailable);
    const dispositions: string[] = [];
    let firstProjected = false;
    while (BigInt((await cursor.read(consumer)).sequence)
      < BigInt((await content.ownerPosition()).sequence)) {
      const result = await relayContentProjectionOnce(env, content, cursor, consumer);
      if (!result) throw new Error('Content projection stopped before owner high water');
      dispositions.push(result.disposition);
      if (result.disposition === 'projected' && !firstProjected) {
        firstProjected = true;
        await expect(queryPublicContentPhrase(env, content, cursor, consumer,
          { phrase: marker, language: 'en' })).rejects.toBeInstanceOf(ContentProjectionUnavailable);
      }
    }
    expect(dispositions.filter(value => value === 'projected')).toHaveLength(2);
    const phrase = await queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: marker, language: 'en' });
    expect(phrase.complete).toBe(true);
    expect(phrase.total).toBe(2);
    expect(phrase.results.map(row => [row.variant, row.revision, row.language]).sort())
      .toEqual(saved.map(item => [item.id, `urn:rezics:content:revision:${item.revision}`, 'en']).sort());
    for (const item of saved) {
      const exact = await queryPublicContentPhrase(env, content, cursor, consumer,
        { phrase: item.unique, language: 'en' });
      expect(exact.results.map(row => row.variant)).toEqual([item.id]);
    }
    const unitInventory = async () => {
      const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?unit ?variant WHERE {
        GRAPH <urn:rezics:search:public> {
          ?unit a rv:MatchUnit ; rv:resource <${work.work}> ;
            rv:variant ?variant ; rv:projection ?projection . }
      }`);
      return (result.results?.bindings ?? []).map(row => [row.unit?.value, row.variant?.value]).sort();
    };
    const units = await unitInventory();
    expect(units).toHaveLength(2);
    expect(new Set(units.map(row => row[0])).size).toBe(2);
    expect(units.map(row => row[1]).sort()).toEqual(saved.map(item => item.id).sort());

    const graphBeforeReplay = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?n WHERE {
      GRAPH <${GRAPHS.control}> { <${DATASET}> rv:sequence ?n . } }`);
    const replayConsumer = `variant-replay-${randomUUID()}`;
    await cursor.initialize(replayConsumer);
    let duplicateProjections = 0;
    while (BigInt((await cursor.read(replayConsumer)).sequence)
      < BigInt((await content.ownerPosition()).sequence)) {
      const result = await relayContentProjectionOnce(env, content, cursor, replayConsumer);
      if (!result) throw new Error('Content replay stopped before owner high water');
      if (result.disposition === 'projected') duplicateProjections++;
    }
    expect(duplicateProjections).toBe(2);
    const graphAfterReplay = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?n WHERE {
      GRAPH <${GRAPHS.control}> { <${DATASET}> rv:sequence ?n . } }`);
    expect(graphAfterReplay.results?.bindings?.[0]?.n?.value)
      .toBe(graphBeforeReplay.results?.bindings?.[0]?.n?.value);
    expect(await unitInventory()).toEqual(units);

    function graphAdmission(scope: string, action: string, digest: string): RegisteredAdmission {
      const id = randomUUID();
      return { id, principalId, actingSubject: actor, scope,
        action, idempotencyKey: `variant-graph-${id}`,
        requestDigest: digest, authorityEpoch: '0',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        state: 'claimed', dispatchEligible: true, replayed: false };
    }
    const realms = [] as string[];
    for (let index = 0; index < 2; index++) {
      const input = { name: `Variant Realm ${index} ${randomUUID()}`, actingSubject: actor };
      const result = await createRealmSpace(env,
        graphAdmission('space:create:root', 'space.create', spaceCreationDigest(input)), input);
      expect(result.outcome).toBe('succeeded');
      if (!result.realm) throw new Error('Realm capability is absent');
      realms.push(result.realm);
    }
    expect(new Set(realms).size).toBe(2);
    const localDraftInput = { work: work.work, language: 'en',
      body: `Realm-only native body ${randomUUID()}`, actingSubject: actor };
    const localDraft = await activateTextContribution(env,
      graphAdmission(`contribution:create:${work.work}`, 'contribution.create',
        textContributionDigest(localDraftInput)),
      localDraftInput);
    expect(localDraft.outcome).toBe('succeeded');
    if (!localDraft.contribution || !localDraft.draftRevision) {
      throw new Error('Realm native contribution was not created');
    }
    const localPublishInput = { contribution: localDraft.contribution,
      expectedDraftHead: localDraft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution' as const, disclosure: 'public' as const,
      actingSubject: actor };
    const localPublication = await publishTextContribution(env,
      graphAdmission(`contribution:publish:${localDraft.contribution}`, 'contribution.publish',
        textPublicationDigest(localPublishInput)),
      localPublishInput);
    expect(localPublication.outcome).toBe('succeeded');
    if (!localPublication.publicationDecision) throw new Error('Realm native publication is absent');
    const localInput = { context: { kind: 'realm-local' as const, id: realms[0]! },
      work: work.work, mainVersion: work.mainVersion,
      contribution: localDraft.contribution,
      publicationDecision: localPublication.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review' as const,
      actingSubject: actor };
    const localSelection = await selectRealmLocal(env,
      graphAdmission(`publication:adopt:${realms[0]}`, 'publication.adopt',
        realmSelectionDigest(localInput)),
      localInput);
    expect(localSelection.outcome).toBe('succeeded');
    const localUnits = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?realm ?unit WHERE {
      GRAPH <urn:rezics:search:public> {
        ?unit a rv:MatchUnit ; rv:work <${work.work}> ; rv:realm ?realm . }
    }`);
    expect(localUnits.results?.bindings.map(row => row.realm?.value)).toEqual([realms[0]]);
    expect(await unitInventory()).toEqual(units);
    const afterRealms = await queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: marker, language: 'en' });
    expect(afterRealms.results.map(row => row.variant).sort()).toEqual(saved.map(item => item.id).sort());
  } finally {
    await accessPool.end();
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 90_000);
