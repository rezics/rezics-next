import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { applyQaSqlMigrations } from '../../../scripts/qa/bootstrap.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { qaStartupTestTimeout, runQaAdmissionChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { scriptCommand } from '../../../scripts/dev/commands.ts';
import { migrateTracked } from '../../../scripts/ops/migrate.ts';
import { offlineTextIndex, sha256 } from '../../../scripts/operations/search-state.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { saveAdmittedContentDraft } from '../../../services/main/src/modules/content-publication/draft.ts';
import { contentPublicationDigest, publishPinnedContent }
  from '../../../services/main/src/modules/content-publication/publish.ts';
import { contentSearchEligibilityDigest, selectPublicContentSearch }
  from '../../../services/main/src/modules/content-publication/eligibility.ts';
import { contentRebuildDelivery, prepareContentRebuild }
  from '../../../services/main/src/modules/content-publication/rebuild-preflight.ts';
import { activateRebuiltPublicContentSearch, clearQuarantinedContentUnits,
  quarantinePublicContentSearch, replayQuarantinedContentCut, resumeActivatedContentRebuild }
  from '../../../services/main/src/modules/content-publication/rebuild.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { queryPublicContentPhrase } from '../../../services/main/src/modules/content-publication/search.ts';
import { relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { DATASET, GRAPHS, RV, initializeFreshGraph, iri }
  from '../../../services/main/src/modules/work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { seedRecoveryContent } from './search-content-fixture.ts';
import { qaStack } from './search-ops-support.ts';

const root = resolve(import.meta.dir, '../../..');

async function rootCommand(args: string[], timeout: number): Promise<string> {
  const result = await runQaAdmissionChildAsync(root, ...scriptCommand(args), timeout);
  if (result.status !== 0 || result.error) {
    throw new Error(`project command ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || '').slice(-4000)}`);
  }
  return result.stdout;
}

// Extends the private-publication reproducer using the same isolated
// owner stack, now crossing the closed, unresolved, approval and recovery paths.
test('SEARCH19/SEARCH20/OPS16: private publication, later approval and frozen rebuild recover together', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.REZICS_QA_ARTIFACT_DIR) {
    throw new Error('Run through the isolated fault/recovery QA tier');
  }
  const runId = `${Bun.env.REZICS_QA_RUN_ID}-cp`;
  const options = { profile: 'qa' as const, runId, persistent: true, rawUpdate: true };
  const stackArgs = ['--profile', 'qa', '--run-id', runId, '--persistent', '--raw-update'];
  let started = false;
  try {
    started = true;
    await rootCommand(['stack:up', ...stackArgs], 180_000);
    const apps = readEnv(join(stackDirectory(root, options), 'apps.env'));
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
    const env = { fuseki, lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! },
      objectDirectory: apps.MAIN_OBJECT_DIRECTORY! };
    await initializeFreshGraph(fuseki, env.lineage);
    await applyQaSqlMigrations(apps.ACCESS_DATABASE_URL!, join(root, 'services/main/migrations/access'), schemaFiles(root, 'access'));
    await migrateTracked(apps.MAIN_RELAY_DATABASE_URL!, root, 'services/main/migrations/relay');
    const pool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 4 });
    const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 4 });
    const relayPool = new Pool({ connectionString: apps.MAIN_RELAY_DATABASE_URL, max: 2 });
    try {
      await migrateContent(pool);
      const content = new ContentCore(pool);
      const cursor = new ContentProjectionCursor(pool);
      const consumer = apps.CONTENT_PROJECTION_CONSUMER ?? 'main-content-public-search-v1';
      await cursor.initialize(consumer);
      const corpus = await seedRecoveryContent(env, pool, accessPool);
      const work = corpus.works[0]!;
      const actor = corpus.content.actingSubject;
      const principal = corpus.content.principal;
      const registry = new AccessAdmissionRegistry(accessPool);
      const principalRow = await accessPool.query('SELECT id FROM access.principal WHERE account_issuer=$1 AND account_subject=$2',
        [principal.issuer, principal.subject]);
      if (principalRow.rowCount !== 1) throw new Error('Content fixture principal is absent');
      const principalId = principalRow.rows[0]!.id as string;
      const account = { verify: async () => principal };
      const request = new Request('http://main.local/v1/content-drafts', {
        method: 'POST', headers: { authorization: 'Bearer qa' } });
      async function grant(scope: string, action: string) {
        await grantFixtureAuthority(accessPool, { scope, requireDispatch: true,
          representations: [{ principalId, actor, action, lifetime: '8 hours' }],
          grant: { actor, action, lifetime: '8 hours' } });
      }
      async function publish(variantId: string, body: string, expectedHead: string | null = null,
        expectedPublicationHead: string | null = null) {
        await grant(`content:draft:${work}`, 'content.draft');
        await grant(`content:publish:${variantId}`, 'content.publish');
        await grant(`content:search-eligibility:${variantId}`, 'content.search-eligibility');
        const saved = await saveAdmittedContentDraft(env, content, account, registry, request,
          { resourceId: work, variant: { id: variantId, resourceId: work,
            language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
          expectedHead, body, actingSubject: actor, idempotencyKey: `composed-draft-${randomUUID()}` });
        expect(saved.outcome).toBe('succeeded');
        if (!saved.revisionId) throw new Error('Content draft revision is absent');
        const exact = (await content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
        if (exact?.status !== 'available') throw new Error('Content draft bytes are unavailable');
        const input = { preparationId: `composed-publication-${randomUUID()}`, revisionId: saved.revisionId,
          expectedDigest: exact.reference.byteDigest, expectedContentEpoch: saved.position.dataEpoch,
          resourceId: work, variantId, expectedPublicationHead };
        const digest = contentPublicationDigest(input);
        const admission = await registry.register({ principal, actingSubject: actor,
          scope: `content:publish:${variantId}`, action: 'content.publish',
          idempotencyKey: `composed-publish-${randomUUID()}`, requestDigest: digest });
        const result = await publishPinnedContent(env, content, await registry.claim(admission.id, digest), input);
        expect(result.status).toBe('active');
        if (!result.decision) throw new Error('Content publication decision is absent');
        return { variantId, body, revision: saved.revisionId, decision: result.decision, preparationId: input.preparationId };
      }
      async function approve(publication: Awaited<ReturnType<typeof publish>>, expectedEligibilityHead: string | null) {
        const input = { resourceId: work, variantId: publication.variantId,
          publicationDecision: publication.decision, expectedEligibilityHead, actingSubject: actor,
          rightsBasis: 'original-contribution' as const, disclosure: 'public' as const };
        const digest = contentSearchEligibilityDigest(input);
        const admission = await registry.register({ principal, actingSubject: actor,
          scope: `content:search-eligibility:${publication.variantId}`, action: 'content.search-eligibility',
          idempotencyKey: `composed-approval-${randomUUID()}`, requestDigest: digest });
        const result = await selectPublicContentSearch(env, content, registry,
          await registry.claim(admission.id, digest), input);
        expect(result.outcome).toBe('succeeded');
        if (!result.decision) throw new Error('Public eligibility decision is absent');
        return result.decision;
      }
      const delivery = contentRebuildDelivery(env, content, relayPool, apps.MAIN_RELAY_CONSUMER!);
      async function deliver(source = content) {
        const bridge = contentRebuildDelivery(env, source, relayPool, apps.MAIN_RELAY_CONSUMER!);
        await bridge.relayPosition();
        while (await bridge.relayOnce() !== null) { /* real retained Main handoff */ }
        const through = await bridge.relayPosition();
        while (await bridge.deliverOnce(through) !== null) { /* durable Content ingestion */ }
      }
      async function drain(reader = cursor, readerConsumer = consumer) {
        for (let i = 0; i < 200; i++) {
          const result = await relayContentProjectionOnce(env, content, reader, readerConsumer);
          if (!result) return;
          if (result.disposition === 'deferred'
            && (await reader.readScan(readerConsumer)).sequence === (await content.ownerPosition()).sequence) return;
        }
        throw new Error('Content relay did not settle within the bounded fixture history');
      }
      async function raw(update: string) {
        const response = await fetch(new URL('../raw-rezics/update', apps.FUSEKI_URL!), {
          method: 'POST', headers: { 'content-type': 'application/sparql-update' }, body: update,
          signal: AbortSignal.timeout(10_000) });
        expect(response.ok).toBe(true);
      }
      const app = createMainApp(fuseki, { environment: env, account, access: registry,
        content, contentAuthoring: content, erasures: new ErasureService(relayPool, pool, accessPool),
        contentProjection: { content, cursor, consumer } });
      const health = async (path: string) => (await app.handle(new Request(`http://main.local/health/${path}`))).status;
      const phrase = (body: string) => queryPublicContentPhrase(env, content, cursor, consumer, { phrase: body, language: 'en' });
      const units = async () => ((await fuseki.query(`PREFIX rv: <${RV}> SELECT ?variant ?revision WHERE {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit a rv:MatchUnit ; rv:projection ?projection ;
          rv:variant ?variant ; rv:revision ?revision .
          FILTER(STRSTARTS(STR(?unit), "urn:rezics:content:match-unit:")
            && STRSTARTS(STR(?projection), "urn:rezics:content:projection:")) } }`)).results?.bindings ?? [])
        .map(row => `${row.variant!.value}|${row.revision!.value}`).sort();
      const expected = (publications: Array<{ variantId: string; revision: string }>) => publications
        .map(value => `${value.variantId}|urn:rezics:content:revision:${value.revision}`).sort();
      const pendingCount = async () => Number((await pool.query(
        'SELECT count(*)::text AS count FROM content.projection_pending WHERE consumer=$1', [consumer])).rows[0]!.count);

      const privatePublication = await publish(`urn:rezics:variant:${randomUUID()}`, 'private cobalt lantern');
      await deliver();
      let lostAck = false;
      const interruptedAck = new Proxy(cursor, { get(target, key) {
        if (key === 'acknowledge') return async (...args: Parameters<ContentProjectionCursor['acknowledge']>) => {
          const events = await content.readOutbox(args[2].dataEpoch, args[1].sequence, 1);
          if (!lostAck && events[0]?.eventType === 'content.publication.active'
            && events[0].payload.preparationId === privatePublication.preparationId) {
            lostAck = true;
            throw new Error('test: lost closed evaluation acknowledgement');
          }
          return target.acknowledge(...args);
        };
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      } });
      await expect(drain(interruptedAck)).rejects.toThrow('test: lost closed evaluation acknowledgement');
      expect(lostAck).toBe(true);
      await drain();
      expect(await cursor.read(consumer)).toEqual(await content.ownerPosition());
      expect(await units()).toEqual(expected([{ variantId: corpus.content.variantId, revision: corpus.content.revisionId }]));
      expect(await phrase(privatePublication.body)).toMatchObject({ complete: true, total: 0 });
      expect(await phrase('exact content beacon')).toMatchObject({ complete: true, total: 1 });
      expect(await health('search-ready')).toBe(200);
      // No default decision was manufactured for a successfully excluded body.
      expect((await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
        ${iri(privatePublication.variantId)} rv:publicSearchEligibilityHead ?head } }`)).boolean).toBe(false);

      const damaged = await publish(`urn:rezics:variant:${randomUUID()}`, 'unresolved copper lantern');
      const corruptHead = `urn:rezics:corrupt-eligibility:${randomUUID()}`;
      await raw(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(damaged.variantId)}
        rv:publicSearchEligibilityHead ${iri(corruptHead)} } }`);
      await drain();
      expect(BigInt((await cursor.read(consumer)).sequence)).toBeLessThan(BigInt((await content.ownerPosition()).sequence));
      expect(await pendingCount()).toBeGreaterThan(0);
      await expect(phrase('exact content beacon')).rejects.toThrow();
      expect(await health('search-ready')).toBe(503);
      expect(await health('ready')).toBe(200);

      const oldId = randomUUID();
      const jobFile = join(stackDirectory(root, options), 'content-rebuild.json');
      const frozen = await prepareContentRebuild({ env, content, delivery,
        remember: frontier => writeFileSync(jobFile, JSON.stringify({ id: oldId, frontier }) + '\n', { mode: 0o600 }),
        assertWritersStopped: async () => undefined });
      const job = await quarantinePublicContentSearch(env, content, oldId, undefined, frozen.cut);
      expect(await clearQuarantinedContentUnits(env, job)).toBe(1);
      await offlineTextIndex(qaStack(runId, { rawUpdate: true }).runner);
      const interruptedUnresolved = new Proxy(cursor, { get(target, key) {
        if (key === 'acknowledge') return async (...args: Parameters<ContentProjectionCursor['acknowledge']>) => {
          await target.acknowledge(...args);
          if (args[3]?.target === damaged.variantId) throw new Error('test: crash after unresolved proof retention');
        };
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      } });
      await expect(replayQuarantinedContentCut(env, content, interruptedUnresolved, job))
        .rejects.toThrow('test: crash after unresolved proof retention');
      expect(BigInt((await cursor.readScan(job.consumer)).sequence)).toBeGreaterThan(0n);
      expect(BigInt((await cursor.read(job.consumer)).sequence)).toBeLessThan(BigInt(job.cut.sequence));
      await expect(activateRebuiltPublicContentSearch(env, content, cursor, job, consumer, 'a'.repeat(64))).rejects.toThrow();
      expect(await health('search-ready')).toBe(503);
      await raw(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(damaged.variantId)}
        rv:publicSearchEligibilityHead ${iri(corruptHead)} } }`);
      const noDelivery = async (): Promise<never> => { throw new Error('frozen resume attempted delivery'); };
      expect(await prepareContentRebuild({ env, content, frontier: frozen,
        delivery: { relayPosition: noDelivery, relayOnce: noDelivery, deliveryPosition: noDelivery, deliverOnce: noDelivery },
        remember: () => undefined, assertWritersStopped: async () => undefined })).toEqual(frozen);
      // A partially replayed job without an immutable offline receipt continues
      // under a fresh UUID, preserving C and the old receipts.
      const output = await rootCommand(['search:rebuild', '--job', oldId, ...stackArgs], 420_000);
      expect(output).toContain(`previous job ${oldId} had no offline evidence`);
      const rebuilt = JSON.parse(output.trim().split(/\r?\n/u).at(-1) ?? '') as { job: string; generation: string };
      expect(rebuilt.job).not.toBe(oldId);
      expect(await cursor.read(consumer)).toEqual(frozen.cut);
      expect(await pendingCount()).toBe(0);
      expect(await units()).toEqual(expected([{ variantId: corpus.content.variantId, revision: corpus.content.revisionId }]));
      for (const closed of [privatePublication, damaged]) expect(await phrase(closed.body)).toMatchObject({ complete: true, total: 0 });
      expect(await phrase('exact content beacon')).toMatchObject({ complete: true, total: 1, indexGeneration: rebuilt.generation });
      expect(await health('search-ready')).toBe(200);

      // Native activation commits before the public SQL checkpoint adopts C.
      const recovery = await quarantinePublicContentSearch(env, content, randomUUID());
      expect(await clearQuarantinedContentUnits(env, recovery)).toBe(1);
      const offline = await offlineTextIndex(qaStack(runId, { rawUpdate: true }).runner);
      await replayQuarantinedContentCut(env, content, cursor, recovery);
      const parkedConsumer = `composed-activation-${randomUUID()}`;
      await cursor.initialize(parkedConsumer);
      for (const event of await content.readOutbox(recovery.cut.dataEpoch, '0', 100)) {
        const checkpoint = await cursor.readScan(parkedConsumer);
        await cursor.acknowledge(parkedConsumer, checkpoint, event.position,
          event.eventType === 'content.publication.active' && event.payload.preparationId === privatePublication.preparationId
            ? { event, target: privatePublication.variantId } : undefined);
      }
      const beforeAdoption = await cursor.read(parkedConsumer);
      expect(BigInt(beforeAdoption.sequence)).toBeLessThan(BigInt(recovery.cut.sequence));
      const lostAdoption = new Proxy(cursor, { get(target, key) {
        if (key === 'adoptRebuildCheckpoint') return async () => { throw new Error('test: lost activated SQL adoption'); };
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      } });
      await expect(activateRebuiltPublicContentSearch(env, content, lostAdoption, recovery,
        parkedConsumer, sha256(offline))).rejects.toThrow('test: lost activated SQL adoption');
      expect(await cursor.read(parkedConsumer)).toEqual(beforeAdoption);
      const control = async () => (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence ?generation WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence ; rv:textIndexGeneration ?generation } }`)).results?.bindings;
      const activated = await control();
      const generation = await resumeActivatedContentRebuild(env, content, cursor, recovery.id, parkedConsumer);
      expect(generation).toBeTruthy();
      expect(await resumeActivatedContentRebuild(env, content, cursor, recovery.id, parkedConsumer)).toBe(generation);
      expect(await control()).toEqual(activated);
      expect(await cursor.read(parkedConsumer)).toEqual(recovery.cut);
      expect(await cursor.read(consumer)).toEqual(recovery.cut);

      let e1 = await approve(privatePublication, null);
      let lostRelayAck = false;
      await expect((async () => {
        while (await relayMainOutboxOnce(fuseki, relayPool, apps.MAIN_RELAY_CONSUMER!, {
          afterDelivery: async batch => {
            const retained = await relayPool.query(`SELECT 1 FROM relay.delivered_event
              WHERE data_epoch=$1 AND sequence=$2
                AND envelope->'data'->'receipt'->>'eligibilityDecision'=$3`, [batch.dataEpoch, batch.sequence, e1]);
            if (retained.rowCount) {
              lostRelayAck = true;
              throw new Error('test: lost retained approval relay acknowledgement');
            }
          },
        }) !== null) { /* fail only after the exact approval is retained */ }
      })()).rejects.toThrow('test: lost retained approval relay acknowledgement');
      expect(lostRelayAck).toBe(true);
      let lostIngestion = false;
      const interruptedContent = new Proxy(content, { get(target, key) {
        if (key === 'ingestEligibilityDeliveryPage') return async (...args: Parameters<ContentCore['ingestEligibilityDeliveryPage']>) => {
          const result = await target.ingestEligibilityDeliveryPage(...args);
          if (!lostIngestion && args[0].batches.some(batch => batch.events.length > 0)) {
            lostIngestion = true;
            throw new Error('test: lost committed approval ingestion');
          }
          return result;
        };
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      } });
      await expect(deliver(interruptedContent)).rejects.toThrow('test: lost committed approval ingestion');
      await deliver();
      // A second decision on the same publication lands between the first
      // body's native commit and acknowledgement. Both deliveries retain their
      // own source identities, and the retry converges to one current body.
      let approvalRace = false;
      const racingAck = new Proxy(cursor, { get(target, key) {
        if (key === 'acknowledge') return async (...args: Parameters<ContentProjectionCursor['acknowledge']>) => {
          const events = await content.readOutbox(args[2].dataEpoch, args[1].sequence, 1);
          if (!approvalRace && events[0]?.payload.sourceReceipt?.eligibilityDecision === e1) {
            approvalRace = true;
            e1 = await approve(privatePublication, e1);
            await deliver();
            throw new Error('test: newer approval before body acknowledgement');
          }
          return target.acknowledge(...args);
        };
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      } });
      await expect(drain(racingAck)).rejects.toThrow('test: newer approval before body acknowledgement');
      expect(approvalRace).toBe(true);
      await drain();
      expect(await phrase(privatePublication.body)).toMatchObject({ complete: true, total: 1 });
      expect(await units()).toEqual(expected([{ variantId: corpus.content.variantId, revision: corpus.content.revisionId }, privatePublication]));
      await deliver();
      await drain();
      expect(await phrase(privatePublication.body)).toMatchObject({ complete: true, total: 1 });

      // Two ordered replacements share one target. A newer publication commits
      // while the old approval is durable but has not yet reached the body worker.
      const p2 = await publish(privatePublication.variantId, 'replacement silver lantern', privatePublication.revision, privatePublication.decision);
      const e2 = await approve(p2, e1);
      await deliver();
      const stale = `composed-stale-${randomUUID()}`;
      await cursor.initialize(stale);
      const events = await content.readOutbox((await content.ownerPosition()).dataEpoch, '0', 100);
      const oldApproval = events.find(event => event.payload.sourceReceipt?.eligibilityDecision === e2);
      if (!oldApproval) throw new Error('Ordered approval delivery is absent');
      while (BigInt((await cursor.readScan(stale)).sequence) + 1n < BigInt(oldApproval.position.sequence)) {
        if (!await relayContentProjectionOnce(env, content, cursor, stale)) throw new Error('Stale worker stopped before approval');
      }
      let p3: Awaited<ReturnType<typeof publish>> | undefined;
      let staleStatus: string | undefined;
      const racingFuseki = new Proxy(fuseki, { get(target, key) {
        if (key === 'command') return async (envelope: Parameters<FusekiClient['command']>[0]) => {
          if (!p3) {
            p3 = await publish(privatePublication.variantId, 'current golden lantern', p2.revision, p2.decision);
            await approve(p3, e2);
            await deliver();
            await drain();
          }
          const result = await target.commandWithReceipt(envelope);
          staleStatus = result.status;
          return result;
        };
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      } });
      // The tick retries pending work before scanning its next source event.
      // The interleaved replacement makes that source obsolete, so its proved
      // supersession is acknowledged while the retry returns its original receipt.
      expect(await relayContentProjectionOnce({ ...env, fuseki: racingFuseki }, content, cursor, stale))
        .toMatchObject({ sourceSequence: oldApproval.position.sequence, disposition: 'superseded' });
      expect(staleStatus).toBe('committed');
      if (!p3) throw new Error('Newer publication was not interleaved');
      await drain(cursor, stale);
      await drain();
      expect(await cursor.read(consumer)).toEqual(await content.ownerPosition());
      expect(await units()).toEqual(expected([{ variantId: corpus.content.variantId, revision: corpus.content.revisionId }, p3]));
      for (const closed of [privatePublication, p2, damaged]) expect(await phrase(closed.body)).toMatchObject({ complete: true, total: 0 });
      expect(await phrase(p3.body)).toMatchObject({ complete: true, total: 1 });
      expect(await health('search-ready')).toBe(200);
      // Erasing an obsolete exact revision must not revive its old approval or
      // destroy the newer eligible unit when the entire source history replays.
      await grant(`erasure:${work}`, 'erasure.request');
      const erasure = await app.handle(new Request('http://main.local/v1/erasures', {
        method: 'POST', headers: { authorization: 'Bearer qa', 'content-type': 'application/json',
          'idempotency-key': `composed-erasure-${randomUUID()}` },
        body: JSON.stringify({ profile: 'content-revision-erasure-v1', actingSubject: actor,
          resourceId: work, revisionIds: [privatePublication.revision] }) }));
      expect({ status: erasure.status, body: await erasure.json() }).toMatchObject({ status: 200,
        body: { suppression: 'suppressed' } });
      expect((await content.readExactBatch([privatePublication.revision], async ids => new Set(ids)))[0]?.status).toBe('erased');
      await deliver();
      await drain();
      // A full replay after a rebuild uses a new rebuild identity. Live receipts
      // refer to units the earlier rebuild retired and cannot certify its copies.
      const erasedOutput = await rootCommand(['search:rebuild', '--job', randomUUID(), ...stackArgs], 420_000);
      const erasedRebuild = JSON.parse(erasedOutput.trim().split(/\r?\n/u).at(-1) ?? '') as { job: string };
      expect(await cursor.read(`content-rebuild.${erasedRebuild.job}`)).toEqual(await content.ownerPosition());
      expect(await cursor.read(consumer)).toEqual(await content.ownerPosition());
      expect(await units()).toEqual(expected([{ variantId: corpus.content.variantId, revision: corpus.content.revisionId }, p3]));
      expect(await phrase(privatePublication.body)).toMatchObject({ complete: true, total: 0 });
      expect(await phrase(p3.body)).toMatchObject({ complete: true, total: 1 });
      expect(await health('search-ready')).toBe(200);
      const pending = await pool.query(`SELECT consumer, data_epoch, sequence::text, event_id, target
        FROM content.projection_pending ORDER BY consumer, sequence`);
      console.info(`CONTENT_PRIVATE_PROJECTION_EVIDENCE ${JSON.stringify({ qaRunId: Bun.env.REZICS_QA_RUN_ID,
        frozen, oldJob: oldId, freshJob: rebuilt.job, recovery: recovery.id, generation,
        owner: await content.ownerPosition(), completed: await cursor.read(consumer),
        scan: await cursor.readScan(consumer), pending: pending.rows, units: await units() })}`);
    } finally {
      await Promise.all([pool.end(), accessPool.end(), relayPool.end()]);
    }
  } finally {
    if (started) await rootCommand(['stack:reset', ...stackArgs], 120_000);
  }
}, qaStartupTestTimeout(600_000));
