import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ContentCore, ContentProjectionCursor, ContentUnavailable,
  migrateContent, type VariantIdentity } from '../../content/src/index.ts';
import { FusekiClient, type CommandEnvelope, type CommandPosition,
  type CommandResult } from '../src/infrastructure/fuseki.ts';
import { ContentProjectionGap,
  ContentProjectionUnavailable, relayContentProjectionOnce } from
  '../src/modules/content-publication/relay.ts';
import { queryPublicContentPhrase } from '../src/modules/content-publication/search.ts';
import { ContentProjectionWorker } from '../src/content-projection-worker.ts';
import { DATASET, GRAPHS, PUBLIC_SEARCH_ANCHOR, RV, TEXT_INDEX_PROBE, TEXT_INDEX_PROBE_BODY,
  TEXT_INDEX_PROBE_GRAPH, iri, lit, textIndexProbePattern,
  type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { createAdmittedMetadataWork } from '../src/modules/work/create-admitted.ts';
import { saveAdmittedContentDraft } from '../src/modules/content-publication/draft.ts';
import { publishAdmittedContent } from '../src/modules/content-publication/publish-admitted.ts';
import { selectAdmittedPublicContentSearch } from '../src/modules/content-publication/eligibility-admitted.ts';
import { contentRebuildDelivery, type ContentRebuildFrontier }
  from '../src/modules/content-publication/rebuild-preflight.ts';
import { activateRebuiltPublicContentSearch, clearQuarantinedContentUnits, ContentRebuildFreshJob, quarantinePublicContentSearch,
  replayQuarantinedContentCut, verifyQuarantinedContentIndex } from '../src/modules/content-publication/rebuild.ts';
import { configureDisclosure, DisclosureStore } from '../src/modules/disclosure/read.ts';
import { qaStack } from '../../../tests/qa/fault-recovery/search-ops-support.ts';
import { assertPinnedState, inspectFusekiState, offlineTextIndex, rebuildPublicContentSearch,
  repositoryPins, type FusekiStateRunner } from '../../../scripts/operations/search-state.ts';

const root = resolve(import.meta.dir, '../../..');

test('SEARCH15/WORK10: partial Content outbox checkpoint and fail-closed MatchUnit relay', async () => {
  const fusekiUrl = process.env.FUSEKI_URL;
  if (!fusekiUrl) throw new Error('FUSEKI_URL must point to an isolated pinned Fuseki stack');
  const fuseki = new FusekiClient(fusekiUrl);
  expect((await fuseki.query('ASK {}')).boolean).toBe(true);
  const state = join(root, '.temp', `content-projection-${crypto.randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 6 });
  try {
    await migrateContent(pool);
    await migrateContent(pool);
    const content = new ContentCore(pool);
    const cursor = new ContentProjectionCursor(pool);
    const consumer = 'content-search-test';
    const initial = await cursor.initialize(consumer);
    expect(initial.sequence).toBe('0');
    const variant: VariantIdentity = { id: `urn:rezics:variant:${crypto.randomUUID()}`,
      resourceId: `https://rezics.com/id/${crypto.randomUUID()}`,
      language: { kind: 'tag', tag: 'zh', originalTag: 'zh' }, direction: 'ltr' };
    const saved = await content.saveDraft({ operationId: `draft-${crypto.randomUUID()}`,
      variant, expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
      provenance: { author: 'projection-test' }, serializedJson: '{"body":"中文检索投影"}' });
    if (!saved.revisionId) throw new Error('Content revision was not saved');
    const exact = (await content.readExactBatch([saved.revisionId],
      async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new Error('exact Content bytes unavailable');
    const preparationId = `prepare-${crypto.randomUUID()}`;
    const prepared = await content.preparePublication(preparationId, saved.revisionId,
      exact.reference.byteDigest, true, saved.position.dataEpoch);
    const terminal = await content.settlePublication(`settle-${crypto.randomUUID()}`, preparationId,
      { outcome: 'active', revisionId: saved.revisionId,
        receipt: `urn:rezics:receipt:${crypto.randomUUID()}`,
        dataEpoch: 'unproven-graph-epoch', sequence: '7' }, saved.position.dataEpoch);
    expect(terminal.status).toBe('active');
    const events = await content.readOutbox(initial.dataEpoch, '0', 4);
    expect(events.map(event => event.position.sequence)).toEqual(['1', '2', '3']);
    const source = await content.readProjectionPublication(events[2]!);
    expect(source).toMatchObject({ preparationId, status: 'active',
      preparationPosition: prepared.position,
      reference: { revisionId: saved.revisionId, byteDigest: exact.reference.byteDigest } });
    await expect(content.readProjectionPublication({ ...events[2]!,
      payload: { ...events[2]!.payload, revisionId: crypto.randomUUID() } }))
      .rejects.toBeInstanceOf(ContentUnavailable);
    const environment = { fuseki, lineage: { dataEpoch: 'unproven-graph-epoch', routingEpoch: '1' },
      objectDirectory: join(state, 'objects') };
    const firstWorker = new ContentProjectionWorker(
      () => relayContentProjectionOnce(environment, content, cursor, consumer));
    expect((await firstWorker.pollOnce())?.sourceSequence).toBe('1');
    const restartedCursor = new ContentProjectionCursor(pool);
    expect((await restartedCursor.initialize(consumer)).sequence).toBe('1');
    const restartedWorker = new ContentProjectionWorker(
      () => relayContentProjectionOnce(environment, content, restartedCursor, consumer));
    expect((await restartedWorker.pollOnce())?.sourceSequence).toBe('2');
    expect((await cursor.initialize(consumer)).sequence).toBe('2');
    await expect(queryPublicContentPhrase(environment, content, cursor, consumer,
      { phrase: '中文检索', language: 'zh' })).rejects.toBeInstanceOf(ContentProjectionUnavailable);
    // The graph publication proof is deliberately absent. The relay may not acknowledge
    // this Content terminal event, with or without a later installed native profile.
    expect((await relayContentProjectionOnce(environment, content, cursor, consumer))?.disposition).toBe('deferred');
    expect((await cursor.readScan(consumer)).sequence).toBe('3');
    expect(await cursor.retries(consumer)).toHaveLength(1);
    expect((await cursor.read(consumer)).sequence).toBe('2');
    expect((await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(variant.id)} rv:contentPublicationHead ?decision } }`)).boolean).toBe(false);
    expect((await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <urn:rezics:search:public> {
      ?unit a rv:MatchUnit ; rv:variant ${iri(variant.id)} } }`)).boolean).toBe(false);
    await pool.query(`UPDATE content.owner_control SET sequence = sequence + 1 WHERE singleton`);
    await expect(relayContentProjectionOnce(environment, content, cursor, consumer))
      .rejects.toBeInstanceOf(ContentProjectionGap);
    await pool.query(`UPDATE content.owner_control SET data_epoch = gen_random_uuid() WHERE singleton`);
    await expect(cursor.read(consumer)).rejects.toThrow('owner epoch changed');
  } finally {
    await pool.end();
    cluster.remove();
    rmSync(state, { recursive: true, force: true });
  }
}, 30_000);

test('OPS16/SEARCH19: Content source-admitted native body receipt, stopped-index recovery and fresh rebuild delivery', async () => {
  const { FUSEKI_URL, ACCESS_DATABASE_URL, CONTENT_DATABASE_URL, MAIN_RELAY_DATABASE_URL, MAIN_RELAY_CONSUMER,
    MAIN_DATA_EPOCH, MAIN_ROUTING_EPOCH, REZICS_QA_RUN_ID } = process.env;
  if (!FUSEKI_URL || !ACCESS_DATABASE_URL || !CONTENT_DATABASE_URL || !MAIN_RELAY_DATABASE_URL || !MAIN_RELAY_CONSUMER
    || !MAIN_DATA_EPOCH || !MAIN_ROUTING_EPOCH || !REZICS_QA_RUN_ID) {
    throw new Error('Run this fixture through isolated Content projection QA');
  }
  const accessPool = new Pool({ connectionString: ACCESS_DATABASE_URL, max: 4 });
  const contentPool = new Pool({ connectionString: CONTENT_DATABASE_URL, max: 4 });
  const relayPool = new Pool({ connectionString: MAIN_RELAY_DATABASE_URL, max: 2 });
  const state = join(root, '.temp', `content-native-delivery-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  // This fault discards only a response after the real command has committed.
  // The next relay call must re-enter the native writer with the original envelope.
  class LostProjectionAcknowledgement extends FusekiClient {
    armed = true;
    deliveries: { envelope: CommandEnvelope; position: CommandPosition }[] = [];
    override async command(envelope: CommandEnvelope): Promise<CommandResult> {
      const result = await super.command(envelope);
      if (envelope.receipt.startsWith('urn:rezics:receipt:content-projection:')
        && result.status === 'committed') {
        this.deliveries.push({ envelope, position: result.position });
        if (this.armed) {
          this.armed = false;
          throw new Error('test: committed Content projection acknowledgement lost');
        }
      }
      return result;
    }
  }
  const fuseki = new LostProjectionAcknowledgement(FUSEKI_URL);
  const native = new FusekiClient(FUSEKI_URL);
  const env: WorkActivationEnvironment = { fuseki,
    lineage: { dataEpoch: MAIN_DATA_EPOCH, routingEpoch: MAIN_ROUTING_EPOCH },
    objectDirectory: join(state, 'objects') };
  const access = new AccessAdmissionRegistry(accessPool);
  access.configureBaseline(fuseki);
  configureDisclosure(env, new DisclosureStore(accessPool));
  const principal = { issuer: `https://content-delivery-${randomUUID()}.test`, subject: randomUUID() };
  const principalId = randomUUID();
  const actor = `https://rezics.com/id/${randomUUID()}`;
  const account = { verify: async () => principal };
  const request = new Request('http://main.local/content', {
    headers: { authorization: 'Bearer verified-content-fixture' } });
  const frame = (...values: string[]) => values.map(value => `${value.length}:${value}`).join('');
  const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  const publicGraph = 'urn:rezics:search:public';
  const body = '中文检索投影 café 😀 逐字交付';
  const language = 'zh';
  const datatype = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
  const consumer = `content-native-${randomUUID()}`;
  try {
    await migrateContent(contentPool);
    const content = new ContentCore(contentPool);
    const delivery = contentRebuildDelivery(env, content, relayPool, MAIN_RELAY_CONSUMER);
    const cursor = new ContentProjectionCursor(contentPool);
    // This QA fixture owns a clean Content database, so bounded relay work cannot
    // silently omit earlier source events belonging to another fixture.
    expect((await content.ownerPosition()).sequence).toBe('0');
    await cursor.initialize(consumer);
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [actor]);
    const grant = async (scope: string, action: string) => {
      await grantFixtureAuthority(accessPool, { scope, requireDispatch: true,
        representations: [{ principalId, actor, action, lifetime: '8 hours' }],
        grant: { actor, action, lifetime: '8 hours' } });
    };
    await grant('work:create:root', 'work.create');
    const work = await createAdmittedMetadataWork(env, account, access, request, {
      actingSubject: actor, idempotencyKey: randomUUID(), title: 'Content native delivery', language });
    await grant(`content:draft:${work.work}`, 'content.draft');
    await grant(`content:publish:${work.work}`, 'content.publish');
    await grant(`content:search-eligibility:${work.work}`, 'content.search-eligibility');
    await grant(`work:read:${work.work}`, 'work.read');
    const variant: VariantIdentity = { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work.work,
      language: { kind: 'tag', tag: language, originalTag: language }, direction: 'ltr' };
    const saved = await saveAdmittedContentDraft(env, content, account, access, request, {
      resourceId: work.work, variant, expectedHead: null, body,
      actingSubject: actor, idempotencyKey: randomUUID() });
    if (!saved.revisionId) throw new Error('admitted Content revision absent');
    const revision = `urn:rezics:content:revision:${saved.revisionId}`;
    const exact = (await content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new Error('admitted exact Content bytes absent');
    expect(exact.reference.model).toBe('content-shape-v1');
    expect(exact.serializedJson).toBe(JSON.stringify({ body }));
    expect(exact.reference.byteDigest).toBe(sha(exact.serializedJson));
    const preparationId = `content-native-prepare-${randomUUID()}`;
    const publication = await publishAdmittedContent(env, content, account, access, request, {
      preparationId, revisionId: saved.revisionId, expectedDigest: saved.byteDigest,
      expectedContentEpoch: saved.position.dataEpoch, resourceId: work.work, variantId: variant.id,
      expectedPublicationHead: null, actingSubject: actor, idempotencyKey: randomUUID() });
    expect(publication.status).toBe('active');
    if (!publication.decision) throw new Error('terminal graph publication decision absent');
    const deliverApproval = async (approval: Awaited<ReturnType<typeof selectAdmittedPublicContentSearch>>) => {
      if (!approval.decision) throw new Error('Public eligibility decision absent');
      await delivery.relayPosition();
      while (await delivery.relayOnce() !== null) { /* retain every acknowledged Main batch */ }
      const frontier = await delivery.relayPosition();
      while (await delivery.deliverOnce(frontier) !== null) { /* commit bounded Content pages */ }
    };
    const eligibility = await selectAdmittedPublicContentSearch(env, content, account, access, request, {
      resourceId: work.work, variantId: variant.id, publicationDecision: publication.decision,
      expectedEligibilityHead: null, actingSubject: actor, rightsBasis: 'original-contribution',
      disclosure: 'public', idempotencyKey: randomUUID() });
    expect(eligibility.outcome).toBe('succeeded');
    await deliverApproval(eligibility);
    const preparation = await content.readPublicationPreparation(preparationId);
    if (!preparation) throw new Error('Content preparation absent');
    const source = frame(revision, saved.byteDigest, publication.decision,
      preparation.position.dataEpoch, 'content-match-unit-v1');
    const firstOwner = await content.ownerPosition();
    let lost = false;
    for (let n = 0; n < 8; n++) {
      const next = await relayContentProjectionOnce(env, content, cursor, consumer);
      if (next?.disposition === 'deferred') { lost = true; break; }
    }
    expect(lost).toBe(true);
    expect(fuseki.deliveries).toHaveLength(1);
    const first = fuseki.deliveries[0]!;
    expect((await cursor.read(consumer)).sequence).not.toBe(firstOwner.sequence);

    // E2 commits while E1's native write is committed but its Content cursor
    // acknowledgement is lost. E1 must yield only to the exact durable E2 row.
    const nextEligibility = await selectAdmittedPublicContentSearch(env, content, account, access, request, {
      resourceId: work.work, variantId: variant.id, publicationDecision: publication.decision!,
      expectedEligibilityHead: eligibility.decision, actingSubject: actor,
      rightsBasis: 'original-contribution', disclosure: 'public', idempotencyKey: randomUUID() });
    expect(nextEligibility.outcome).toBe('succeeded');
    await deliverApproval(nextEligibility);
    // The same relay tick resolves the pending E1 retry as superseded, then
    // projects the retained E2 delivery at the source checkpoint.
    expect((await relayContentProjectionOnce(env, content, cursor, consumer))?.disposition).toBe('projected');
    const owner = await content.ownerPosition();
    expect(fuseki.deliveries).toHaveLength(2);
    const current = fuseki.deliveries[1]!;
    expect(current.envelope.receipt).not.toBe(first.envelope.receipt);
    expect((await cursor.read(consumer)).sequence).toBe(owner.sequence);
    const receiptBody = async (receipt: string) => {
      const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?unit ?projection ?source ?identity
        ?body ?language (DATATYPE(?body) AS ?datatype) (DATATYPE(?source) AS ?sourceDatatype) WHERE {
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
          rv:contentRevision ${iri(revision)} ; rv:publicationDecision ${iri(publication.decision!)} ;
          rv:eligibility ${iri(nextEligibility.decision!)} ; rv:matchUnit ?unit ; rv:projection ?projection ;
          rv:searchDeltaContentSource ?source ; rv:searchDeltaContentBodyDigest ?identity . }
        GRAPH ${iri(publicGraph)} { ?unit rv:projection ?projection ; rv:searchBody ?body ; rv:language ?language }
      } LIMIT 2`)).results?.bindings ?? [];
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.source?.value).toBe(source);
      expect(row.sourceDatatype?.value).toBe('http://www.w3.org/2001/XMLSchema#string');
      expect(row.body?.value).toBe(body);
      expect(row.body?.['xml:lang']).toBe(language);
      expect(row.language?.value).toBe(language);
      expect(row.datatype?.value).toBe(datatype);
      expect(row.identity?.value).toBe(sha(frame(row.unit!.value, publicGraph, 'body', frame(body, language, datatype))));
      return row;
    };
    const original = await receiptBody(current.envelope.receipt);
    const query = await queryPublicContentPhrase(env, content, cursor, consumer, { phrase: '中文检索', language });
    expect(query.complete).toBe(true);
    expect(query.results.map(row => row.matchUnit)).toContain(original.unit!.value);
    expect(await native.command(current.envelope)).toMatchObject({ status: 'committed', position: current.position });
    await expect(native.command(first.envelope)).rejects.toThrow('Fuseki command returned 500');

    // The allocated QA project must use a named state volume before stopping:
    // ordinary tmpfs would lose the original TDB2 evidence along with Lucene.
    const stack = qaStack(REZICS_QA_RUN_ID, { rawUpdate: true });
    expect(stack.apps.FUSEKI_URL).toBe(FUSEKI_URL);
    expect(stack.composeEnv.REZICS_STACK_STORAGE).toBe('persistent');
    expect(stack.project).toBe(`rezics-qa-${REZICS_QA_RUN_ID}`);
    const expectedPins = repositoryPins(root, stack.dockerEnv, stack.stateVolume, ['rezics-dev_fuseki_data']);
    const allocatedPins = await inspectFusekiState(stack.runner, stack.dockerEnv, fuseki);
    assertPinnedState(allocatedPins, expectedPins);
    const sourceEvidence = async () => (await fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?graph ?subject ?predicate ?object WHERE {
        VALUES ?graph { ${iri(GRAPHS.current)} ${iri(GRAPHS.revisions)} ${iri(GRAPHS.receipts)} }
        VALUES ?subject { ${[variant.id, publication.decision!, publication.receipt,
          eligibility.decision!, eligibility.receipt, nextEligibility.decision!, nextEligibility.receipt,
          first.envelope.receipt, current.envelope.receipt].map(iri).join(' ')} }
        GRAPH ?graph { ?subject ?predicate ?object }
      } ORDER BY ?graph ?subject ?predicate ?object LIMIT 256`)).results?.bindings ?? [];
    const originalEvidence = await sourceEvidence();
    expect(originalEvidence.length).toBeGreaterThan(0);
    expect(originalEvidence.length).toBeLessThan(256);
    const originalPublicationField = (field: string) => {
      const rows = originalEvidence.filter(row => row.subject?.value === publication.receipt
        && row.predicate?.value === `${RV}${field}`);
      expect(rows).toHaveLength(1);
      return rows[0]!.object!.value;
    };
    const originalPublicationDigest = originalPublicationField('byteDigest');
    const originalPublicationEpoch = originalPublicationField('ownerDataEpoch');
    expect(originalPublicationDigest).toBe(saved.byteDigest);
    expect(originalPublicationEpoch).toBe(preparation.position.dataEpoch);
    const physicalBody = async (id: string) => (await fuseki.query(`PREFIX rv: <${RV}>
      PREFIX text: <http://jena.apache.org/text#> SELECT ?literal (DATATYPE(?literal) AS ?datatype) WHERE {
        GRAPH ${iri(publicGraph)} { (${iri(id)} ?score ?literal) text:query (rv:searchBody "中文检索") }
      } LIMIT 2`)).results?.bindings ?? [];
    const beforeStop = await fuseki.commandHealth();
    stack.runner.stop();
    try {
      // Hold the existing owner lock, remove only this project's physical index,
      // and leave TDB2, clean-stop and original receipts untouched.
      stack.runner.offline(`exec 9>>/fuseki/databases/rezics/owner.lock
flock -n 9
test -d /fuseki/databases/rezics/tdb2
test -f /fuseki/databases/rezics/clean-stop
rm -rf /fuseki/databases/rezics/lucene
mkdir /fuseki/databases/rezics/lucene
sync
test -z "$(ls -A /fuseki/databases/rezics/lucene)"`);
    } finally { await stack.runner.start(); }
    expect(await inspectFusekiState(stack.runner, stack.dockerEnv, fuseki)).toEqual(allocatedPins);
    expect((await fuseki.commandHealth()).instanceId).not.toBe(beforeStop.instanceId);
    expect(await sourceEvidence()).toEqual(originalEvidence);
    expect(await receiptBody(current.envelope.receipt)).toEqual(original);
    expect(await physicalBody(original.unit!.value)).toEqual([]);
    await expect(queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: '中文检索', language })).rejects.toThrow();

    const receiptField = async (receipt: string, field: string, value: string | null) => {
      await fuseki.update(`PREFIX rv: <${RV}> DELETE WHERE { GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} rv:${field} ?prior } }`);
      if (value !== null) await fuseki.update(`PREFIX rv: <${RV}> INSERT DATA {
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:${field} ${lit(value)} } }`);
    };
    // A missing or corrupt original descriptor cannot be inferred from the
    // still intact body RDF, current publication pins or PostgreSQL bytes.
    await receiptField(current.envelope.receipt, 'searchDeltaContentSource', null);
    try { await expect(native.command(current.envelope)).rejects.toThrow('Fuseki command returned 500'); }
    finally { await receiptField(current.envelope.receipt, 'searchDeltaContentSource', original.source!.value); }
    await receiptField(current.envelope.receipt, 'searchDeltaContentBodyDigest', '0'.repeat(64));
    try { await expect(native.command(current.envelope)).rejects.toThrow('Fuseki command returned 500'); }
    finally { await receiptField(current.envelope.receipt, 'searchDeltaContentBodyDigest', original.identity!.value); }
    expect(await physicalBody(original.unit!.value)).toEqual([]);
    expect(await sourceEvidence()).toEqual(originalEvidence);

    // Full cleared-cut replay is source-admitted. It replaces only old derived
    // units and never recreates missing original publication authority.
    const job = await quarantinePublicContentSearch(env, content, randomUUID());
    expect(job.cut).toEqual(await content.ownerPosition());
    expect(await clearQuarantinedContentUnits(env, job)).toBe(1);
    expect(await clearQuarantinedContentUnits(env, job)).toBe(0);
    const contentProjectionPresent = async () => (await fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(publicGraph)} { ?unit ?predicate ?value
        FILTER(STRSTARTS(STR(?unit), "urn:rezics:content:match-unit:")) }
    }`)).boolean;
    expect(await contentProjectionPresent()).toBe(false);
    expect(await sourceEvidence()).toEqual(originalEvidence);
    // Rebuild retained probes/names only while Content projections are absent.
    // Fresh Content bodies are admitted afterward by the real job-scoped relay.
    const retainedOfflineLog = await offlineTextIndex(stack.runner);
    expect(await inspectFusekiState(stack.runner, stack.dockerEnv, fuseki)).toEqual(allocatedPins);
    expect(await sourceEvidence()).toEqual(originalEvidence);
    expect(await contentProjectionPresent()).toBe(false);
    expect((await fuseki.query(`PREFIX rv: <${RV}> PREFIX text: <http://jena.apache.org/text#>
      ASK { ${textIndexProbePattern()} }`)).boolean).toBe(true);
    await receiptField(publication.receipt, 'byteDigest', null);
    try {
      await expect(replayQuarantinedContentCut(env, content, cursor, job))
        .rejects.toThrow('Content outbox ended before rebuild cut');
      expect((await cursor.read(job.consumer)).sequence).not.toBe(job.cut.sequence);
      expect(fuseki.deliveries).toHaveLength(2);
    } finally { await receiptField(publication.receipt, 'byteDigest', originalPublicationDigest); }
    await receiptField(publication.receipt, 'ownerDataEpoch', randomUUID());
    try {
      await expect(replayQuarantinedContentCut(env, content, cursor, job))
        .rejects.toThrow('Content outbox ended before rebuild cut');
      expect((await cursor.read(job.consumer)).sequence).not.toBe(job.cut.sequence);
      expect(fuseki.deliveries).toHaveLength(2);
    } finally { await receiptField(publication.receipt, 'ownerDataEpoch', originalPublicationEpoch); }
    expect(await sourceEvidence()).toEqual(originalEvidence);
    fuseki.armed = true;
    await expect(replayQuarantinedContentCut(env, content, cursor, job))
      .rejects.toThrow('Content outbox ended before rebuild cut');
    expect((await cursor.read(job.consumer)).sequence).not.toBe(job.cut.sequence);
    expect(fuseki.deliveries).toHaveLength(3);
    const fresh = fuseki.deliveries.at(-1)!;
    expect(fresh.envelope.receipt).not.toBe(first.envelope.receipt);
    const rebuilt = await receiptBody(fresh.envelope.receipt);
    expect(rebuilt.unit?.value).not.toBe(original.unit?.value);
    expect(rebuilt.source?.value).toBe(original.source?.value);
    expect(await native.command(fresh.envelope)).toMatchObject({ status: 'committed', position: fresh.position });
    expect((await fuseki.query(`PREFIX text: <http://jena.apache.org/text#> PREFIX rv: <${RV}>
      ASK { GRAPH ${iri(publicGraph)} { (?unit ?score) text:query (rv:searchBody "中文检索" 8)
        FILTER(?unit = ${iri(rebuilt.unit!.value)}) } }`)).boolean).toBe(true);

    // The isolated assembler's raw update is a test fault, not source admission.
    // It changes RDF and physical text together; the original receipt stays intact.
    let unit = rebuilt.unit!.value;
    const replaceBody = (value: string | null) => fuseki.update(`PREFIX rv: <${RV}> DELETE {
      GRAPH ${iri(publicGraph)} { ${iri(unit)} rv:searchBody ?prior }
    } ${value === null ? '' : `INSERT { GRAPH ${iri(publicGraph)} { ${iri(unit)} rv:searchBody ${lit(value)}@${language} } }`}
      WHERE { GRAPH ${iri(publicGraph)} { ${iri(unit)} rv:searchBody ?prior } }`);
    await replaceBody('错误物理文本');
    try {
      expect((await fuseki.query(`PREFIX text: <http://jena.apache.org/text#> PREFIX rv: <${RV}>
        ASK { GRAPH ${iri(publicGraph)} { (?unit ?score) text:query (rv:searchBody "错误物理" 8)
          FILTER(?unit = ${iri(unit)}) } }`)).boolean).toBe(true);
      // Native refusal must also keep the real pending relay retry unacknowledged.
      await expect(native.command(fresh.envelope)).rejects.toThrow('Fuseki command returned 500');
      expect(await relayContentProjectionOnce(env, content, cursor, job.consumer, job.id)).toBeNull();
      expect((await cursor.read(job.consumer)).sequence).not.toBe(job.cut.sequence);
      expect(await cursor.retries(job.consumer)).toHaveLength(1);
      expect(fuseki.deliveries).toHaveLength(3);
    } finally { await replaceBody(body); }
    expect(await replayQuarantinedContentCut(env, content, cursor, job)).toBe(1);
    expect((await cursor.read(job.consumer)).sequence).toBe(job.cut.sequence);
    expect(await cursor.retries(job.consumer)).toHaveLength(0);
    expect(fuseki.deliveries).toHaveLength(4);
    expect(fuseki.deliveries[3]).toEqual(fresh);
    expect(await native.command(fresh.envelope)).toMatchObject({ status: 'committed', position: fresh.position });
    await receiptBody(fresh.envelope.receipt);
    expect(await verifyQuarantinedContentIndex(env, content, cursor, job)).toMatchObject({
      unitCount: 1, contentUnitCount: 1 });
    expect(await physicalBody(rebuilt.unit!.value)).toMatchObject([{ literal: {
      value: body, 'xml:lang': language }, datatype: { value: datatype } }]);
    // A second clean reopen retains the repaired committed leaf and the same
    // original source evidence; public activation remains held.
    stack.runner.stop();
    await stack.runner.start();
    expect(await inspectFusekiState(stack.runner, stack.dockerEnv, fuseki)).toEqual(allocatedPins);
    expect(await sourceEvidence()).toEqual(originalEvidence);
    expect(await receiptBody(fresh.envelope.receipt)).toEqual(rebuilt);
    expect(await native.command(fresh.envelope)).toMatchObject({ status: 'committed', position: fresh.position });
    expect(await verifyQuarantinedContentIndex(env, content, cursor, job)).toMatchObject({
      unitCount: 1, contentUnitCount: 1 });
    expect(await physicalBody(rebuilt.unit!.value)).toMatchObject([{ literal: {
      value: body, 'xml:lang': language }, datatype: { value: datatype } }]);

    // Qualify the production composition using these same admitted bytes and
    // original receipts. The preceding component assertions remain retained.
    await activateRebuiltPublicContentSearch(env, content, cursor, job, consumer, sha(retainedOfflineLog));
    let offlinePasses = 0;
    let offlineFault: 'before' | 'after' | null = null;
    let removeProbe = false;
    const runner: FusekiStateRunner = { ...stack.runner,
      offline: script => {
        offlinePasses++;
        if (offlineFault === 'before') throw new Error('test: interrupted before offline');
        const log = stack.runner.offline(script);
        if (offlineFault === 'after') throw new Error('test: interrupted after offline');
        return log;
      },
      start: async () => {
        await stack.runner.start();
        if (removeProbe) await fuseki.update(`PREFIX rv: <${RV}> DELETE WHERE {
          GRAPH ${iri(TEXT_INDEX_PROBE_GRAPH)} { ${iri(TEXT_INDEX_PROBE)} rv:searchBody ?body } }`);
      } };
    const frontiersByJob = new Map<string, ContentRebuildFrontier>();
    const rebuild = (id: string, assertWritersStopped = async () => undefined, continuingJob?: string) =>
      rebuildPublicContentSearch({ runner, dockerEnv: stack.dockerEnv, env, content, cursor,
        delivery, frontier: frontiersByJob.get(id), onFrontierRecorded: frontier => frontiersByJob.set(id, frontier),
        id, continuingJob, publicConsumer: consumer, expected: expectedPins, reserveBytes: 0, assertWritersStopped });
    const control = async () => (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?generation ?anchor WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:textIndexGeneration ?generation }
      OPTIONAL { GRAPH ${iri(publicGraph)} { ${iri(PUBLIC_SEARCH_ANCHOR)} a ?anchor } }
    }`)).results?.bindings;
    const frontiers = async (id: string) => (await contentPool.query(`SELECT consumer, data_epoch,
      sequence::text, scan_sequence::text FROM content.projection_checkpoint
      WHERE consumer = ANY($1::text[]) ORDER BY consumer`, [
      [consumer, `content-rebuild.${id}`] ])).rows;
    const retainedState = async (id: string) => ({ frontiers: await frontiers(id),
      control: await control(), source: await sourceEvidence(), owner: await content.ownerPosition(),
      deliveries: fuseki.deliveries.length });

    // Fresh clear/index-loss/reopen must obtain tagged documents through the
    // real relay after the ordinary offline indexer, then activate only verified inventory.
    stack.runner.stop();
    try { stack.runner.offline(`exec 9>>/fuseki/databases/rezics/owner.lock
flock -n 9
rm -rf /fuseki/databases/rezics/lucene
mkdir /fuseki/databases/rezics/lucene
sync`); }
    finally { await stack.runner.start(); }
    const productionId = randomUUID();
    const production = await rebuild(productionId);
    // The replay now includes both retained eligibility handoffs in Content's sequence.
    expect(production).toMatchObject({ job: productionId, removed: 1, replayed: 5, pins: allocatedPins });
    expect(offlinePasses).toBe(1);
    expect((await cursor.read(consumer)).sequence).toBe(owner.sequence);
    const productionDelivery = fuseki.deliveries.at(-1)!;
    const productionBody = await receiptBody(productionDelivery.envelope.receipt);
    expect(productionBody.source?.value).toBe(original.source?.value);
    expect(await native.command(productionDelivery.envelope)).toMatchObject({
      status: 'committed', position: productionDelivery.position });
    expect(await sourceEvidence()).toEqual(originalEvidence);
    expect((await queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: '中文检索', language })).results.map(row => row.matchUnit))
      .toContain(productionBody.unit!.value);
    stack.runner.stop();
    await stack.runner.start();
    expect(await inspectFusekiState(stack.runner, stack.dockerEnv, fuseki)).toEqual(allocatedPins);
    expect(await receiptBody(productionDelivery.envelope.receipt)).toEqual(productionBody);
    expect(await native.command(productionDelivery.envelope)).toMatchObject({
      status: 'committed', position: productionDelivery.position });

    const interruptedId = randomUUID();
    const beforeQuiescence = offlinePasses;
    const beforeWriterRefusal = await retainedState(interruptedId);
    await expect(rebuild(interruptedId, async () => { throw new Error('test: writer remains'); }))
      .rejects.toThrow('test: writer remains');
    expect(offlinePasses).toBe(beforeQuiescence);
    expect(await contentProjectionPresent()).toBe(true);
    expect(await retainedState(interruptedId)).toEqual(beforeWriterRefusal);
    // A malformed retained Content subject is also nonempty; cleanup's typed
    // inventory must not let it enter the offline indexer.
    const orphan = `urn:rezics:content:match-unit:${randomUUID()}`;
    await fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(publicGraph)} {
      ${iri(orphan)} rv:searchBody ${lit(body)}@${language} } }`);
    try {
      await expect(rebuild(interruptedId)).rejects.toThrow('Content units remain after terminal clear');
      expect(offlinePasses).toBe(beforeQuiescence);
    } finally { await fuseki.update(`DELETE WHERE { GRAPH ${iri(publicGraph)} { ${iri(orphan)} ?p ?o } }`); }
    expect(await contentProjectionPresent()).toBe(false);
    const emptyState = await retainedState(interruptedId);
    for (const phase of ['before', 'after'] as const) {
      offlineFault = phase;
      await expect(rebuild(interruptedId)).rejects.toThrow(`test: interrupted ${phase} offline`);
      expect(await retainedState(interruptedId)).toEqual(emptyState);
      expect(await contentProjectionPresent()).toBe(false);
    }
    offlineFault = null;
    removeProbe = true;
    await expect(rebuild(interruptedId)).rejects.toThrow('rebuilt text index probe is absent');
    expect(await retainedState(interruptedId)).toEqual(emptyState);
    removeProbe = false;
    await fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(TEXT_INDEX_PROBE_GRAPH)} {
      ${iri(TEXT_INDEX_PROBE)} rv:searchBody ${lit(TEXT_INDEX_PROBE_BODY)}@zh } }`);

    // Existing source admission keeps the public frontier held on missing or
    // corrupt originals. Its private scan records pending targets as designed.
    await receiptField(publication.receipt, 'byteDigest', null);
    try {
      await expect(rebuild(interruptedId)).rejects.toThrow('Content outbox ended before rebuild cut');
      expect(await cursor.read(consumer)).toEqual(owner);
      expect(await contentProjectionPresent()).toBe(false);
    } finally { await receiptField(publication.receipt, 'byteDigest', originalPublicationDigest); }
    const pendingState = await retainedState(interruptedId);
    await receiptField(publication.receipt, 'ownerDataEpoch', randomUUID());
    try {
      await expect(rebuild(interruptedId)).rejects.toThrow('Content outbox ended before rebuild cut');
      expect(await frontiers(interruptedId)).toEqual(pendingState.frontiers);
      expect(await control()).toEqual(pendingState.control);
      expect(fuseki.deliveries).toHaveLength(pendingState.deliveries);
    } finally { await receiptField(publication.receipt, 'ownerDataEpoch', originalPublicationEpoch); }
    expect(await sourceEvidence()).toEqual(originalEvidence);
    fuseki.armed = true;
    await expect(rebuild(interruptedId)).rejects.toThrow('Content outbox ended before rebuild cut');
    const partialDelivery = fuseki.deliveries.at(-1)!;
    const partialBody = await receiptBody(partialDelivery.envelope.receipt);
    const partialJob = await quarantinePublicContentSearch(env, content, interruptedId);
    expect(await clearQuarantinedContentUnits(env, partialJob)).toBe(0);
    const partialPasses = offlinePasses;
    // Replay advanced beyond zero without retained offline evidence. Its native
    // receipts cannot recreate cleared units under this job, so continue C with
    // a fresh job, clear the partial inventory, index and replay from zero.
    await expect(rebuild(interruptedId)).rejects.toBeInstanceOf(ContentRebuildFreshJob);
    expect(offlinePasses).toBe(partialPasses);
    expect(await receiptBody(partialDelivery.envelope.receipt)).toEqual(partialBody);
    const freshId = randomUUID();
    const frozenFrontier = frontiersByJob.get(interruptedId);
    if (!frozenFrontier?.cut) throw new Error('interrupted rebuild frozen frontier absent');
    frontiersByJob.set(freshId, frozenFrontier);
    const resumed = await rebuild(freshId, undefined, interruptedId);
    expect(resumed).toMatchObject({ job: freshId, removed: 1, replayed: 5 });
    expect(offlinePasses).toBe(partialPasses + 1);
    expect(resumed.generation).toMatch(/^urn:rezics:text-index-generation:/);
    expect(frontiersByJob.get(freshId)).toEqual(frozenFrontier);
    expect((await cursor.read(consumer)).sequence).toBe(owner.sequence);
    const resumedDelivery = fuseki.deliveries.at(-1)!;
    const resumedBody = await receiptBody(resumedDelivery.envelope.receipt);
    expect(resumedBody.unit?.value).not.toBe(partialBody.unit?.value);
    expect(resumedBody.source?.value).toBe(partialBody.source?.value);
    expect(await physicalBody(partialBody.unit!.value)).toEqual([]);
    expect((await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(partialDelivery.envelope.receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded } }`)).boolean).toBe(true);
    expect(await physicalBody(resumedBody.unit!.value)).toMatchObject([{ literal: {
      value: body, 'xml:lang': language }, datatype: { value: datatype } }]);
    expect(await sourceEvidence()).toEqual(originalEvidence);
    expect(await native.command(resumedDelivery.envelope)).toMatchObject({
      status: 'committed', position: resumedDelivery.position });
    unit = resumedBody.unit!.value;
    const deliveriesBeforeUnavailable = fuseki.deliveries.length;

    // The isolated owner database is disposable. Its immutable unavailable
    // transition stays terminal; the fixture does not disable custody guards.
    await contentPool.query(`UPDATE content.revision SET availability = 'unavailable',
      serialized_bytes = NULL, body = NULL WHERE id = $1`, [saved.revisionId]);
    try {
      await replaceBody(null);
      await expect(native.command(resumedDelivery.envelope)).rejects.toThrow('Fuseki command returned 500');
      const unavailableConsumer = `content-unavailable-${randomUUID()}`;
      await cursor.initialize(unavailableConsumer);
      let refused = false;
      for (let n = 0; n < 8; n++) {
        if ((await relayContentProjectionOnce(env, content, cursor, unavailableConsumer))
          ?.disposition === 'deferred') { refused = true; break; }
      }
      expect(refused).toBe(true);
      expect(fuseki.deliveries).toHaveLength(deliveriesBeforeUnavailable);
    } finally {
      await fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(publicGraph)} {
        ${iri(unit)} rv:searchBody ${lit(body)}@${language} } }`);
    }
  } finally {
    await Promise.all([accessPool.end(), contentPool.end(), relayPool.end()]);
    rmSync(state, { recursive: true, force: true });
  }
}, 420_000);
