import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMainApp } from '../../../services/main/src/app.ts';
import { CommandOutcomeUnknown, CommandRejected, type CommandEnvelope, type CommandResult,
  type FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { ObjectUnavailable, S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { proofRetirementSender } from '../../../services/main/src/modules/graph/slim-command.ts';
import { PostgresReceiptCustodyStore, ReceiptCustody, type ReceiptCustodySession,
  type ReceiptCustodyStore, type SlimEnvelope } from '../../../services/main/src/modules/outbox/receipt-custody.ts';
import { commitMetadata, readMetadataReceipt } from '../../../services/main/src/modules/work/metadata-command.ts';
import { checkedEditionV2, checkedMetadataState, metadataDigest, type MetadataIntent } from '../../../services/main/src/modules/work/metadata-schema.ts';
import { GRAPHS, iri, lit, type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { workEditReceiptIri } from '../../../services/main/src/modules/work/edit.ts';
import { compareEditionCommands, editionCommandFootprint, measureEditionCommand } from '../../../scripts/load/slim-command-measure.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce, relayCoverage, type DeliveredMainEvent }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { DiscoveryRefreshInputs } from '../../../services/main/src/modules/discovery/source.ts';
import { FeedStore, type FeedCheckpoint } from '../../../services/main/src/modules/feed/store.ts';
import { reconcileRelayGap } from '../../../services/main/src/modules/owner/relay-gap.ts';

class ReconciliationFault implements ReceiptCustodyStore {
  fail = false;
  constructor(private readonly owner: ReceiptCustodyStore) {}
  receiptAt(dataEpoch: string, sequence: string) { return this.owner.receiptAt(dataEpoch, sequence); }
  withReceipt<T>(receipt: string, operation: (session: ReceiptCustodySession) => Promise<T>): Promise<T> {
    return this.owner.withReceipt(receipt, session => operation({ ...session,
      reconcile: async (terminal, outbox) => {
        if (this.fail) throw new Error('Owner reconciliation interrupted');
        await session.reconcile(terminal, outbox);
      },
    }));
  }
}

test('edition commands run slim with real CAS, policy, SHACL, replay and owner-custody retirement', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.MAIN_S3_ENDPOINT || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const apps = Bun.env as Record<string, string>;
  const fixture = await authorCreditFixture(apps, resolve('.temp/slim-command-objects'));
  const objects = new S3ImmutableObjects({ endpoint: apps.MAIN_S3_ENDPOINT!, bucket: apps.MAIN_S3_BUCKET!,
    region: apps.MAIN_S3_REGION, accessKeyId: apps.MAIN_S3_ACCESS_KEY!, secretAccessKey: apps.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/work/' });
  await objects.initialize();
  const owner = new ReconciliationFault(new PostgresReceiptCustodyStore(fixture.accessPool));
  let mutation: ((command: CommandEnvelope) => CommandEnvelope) | undefined;
  let beforeSlim: (() => Promise<void>) | undefined;
  let loseResponse = false;
  const dispatched: { envelope: CommandEnvelope; result: CommandResult }[] = [];
  const fuseki = new Proxy(fixture.nativeFuseki, {
    get(target, property) {
      if (property === 'commandWithReceipt') return async (envelope: CommandEnvelope) => {
        const slim = (envelope as Partial<SlimEnvelope>).slim;
        let candidate = envelope;
        if (slim) {
          const before = beforeSlim; beforeSlim = undefined;
          await before?.();
          const change = mutation; mutation = undefined;
          candidate = change ? change(envelope) : envelope;
        }
        const result = await target.commandWithReceipt(candidate);
        dispatched.push({ envelope: candidate, result });
        if (slim && loseResponse && result.status === 'committed') {
          loseResponse = false;
          throw new CommandOutcomeUnknown('Graph response lost after durable commit');
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as FusekiClient;
  const custody = new ReceiptCustody(owner, objects, fuseki, apps.FUSEKI_TITLE_ADMISSION_KEY!,
    proofRetirementSender(apps.FUSEKI_URL!, apps.FUSEKI_COMMAND_TOKEN!));
  const legacy: WorkActivationEnvironment = { ...fixture.env, fuseki, workObjects: objects };
  const slim: WorkActivationEnvironment = { ...legacy, receiptCustody: custody };
  const relay = new Pool({ connectionString: apps.MAIN_RELAY_DATABASE_URL ?? apps.ACCOUNT_RELAY_DATABASE_URL });
  const relayConsumer = `slim:${randomUUID()}`;
  await initializeRelayCheckpoint(relay, relayConsumer, slim.lineage.dataEpoch);
  let lostHandoffReceipt: string | undefined;
  let handoffCrashes = 0;
  const drain = async () => {
    for (let batch = 0; batch < 100; batch++) {
      if (!await relayMainOutboxOnce(fuseki, relay, relayConsumer, { ownerOutbox: custody,
        afterDelivery: async source => {
          if (source.custodiedReceipt === lostHandoffReceipt && handoffCrashes === 0) {
            handoffCrashes++;
            throw new Error('Retained handoff response lost');
          }
        },
      })) return;
    }
    throw new Error('Slim fixture exceeded bounded relay drain');
  };
  try {
    const key = randomUUID();
    const created = await fixture.json<{ work: string }>(await fixture.call('POST', '/v1/works',
      await fixture.catalogueBody({ profile: 'metadata-only-v1', title: 'Slim edition measurement', language: 'en',
        actingSubject: fixture.actor }, key), key), 201);
    const work = created.work;
    await fixture.grant(`work:edit:${work}`, 'work.edit');
    const principal = await fixture.account.verifier.verify(new Request('http://main.local', {
      headers: { authorization: `Bearer ${fixture.account.tokenA}` },
    }), ['work:edit']);
    const admission = async (intent: MetadataIntent) => {
      const digest = metadataDigest(intent);
      const registered = await fixture.access.register({ principal, actingSubject: fixture.actor,
        action: 'work.edit', scope: `work:edit:${work}`, idempotencyKey: Bun.randomUUIDv7(), requestDigest: digest });
      return fixture.access.claim(registered.id, digest, principal);
    };
    const header: MetadataIntent = { work, expectedHead: null, state: checkedMetadataState({ kind: 'header',
      originalTitle: { value: 'Slim edition measurement', language: 'en' }, localized: [] }) };
    const headerAdmission = await admission(header);
    expect(await commitMetadata(legacy, headerAdmission, header)).toBe(true);
    let headerHead = (await readMetadataReceipt(legacy, headerAdmission.id))!.revision!;
    // Public resource names use their native rank scope; generic text:query
    // deliberately excludes this separate title-only population.
    const textUnits = async () => {
      const rows = (await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?page WHERE {
        BIND(rv:rankedText(rv:publicTitle, "Slim", 20, "",
          ${lit(JSON.stringify({ names: 'work', resources: [work] }))}) AS ?page)
      }`)).results!.bindings;
      const page = JSON.parse(rows[0]!.page!.value) as { hits: { id: string; key: string | null }[] };
      return page.hits.filter(hit => hit.key !== null).map(hit => hit.id).sort();
    };
    const beforeText = await textUnits();
    expect(beforeText.length).toBeGreaterThan(0);
    expect(beforeText.every(unit => unit.endsWith(shortId(work)))).toBe(true);
    const edition = checkedMetadataState({ kind: 'edition', id: nativeId(), status: 'active',
      title: { value: 'Measured edition', language: 'en' }, contentLanguage: 'en', editionStatement: 'First edition',
      publisher: 'Fixture Press', publicationYear: 2026, isbn13: '9780306406157' });
    const first: MetadataIntent = { work, expectedHead: null, state: edition };
    const before = await measureEditionCommand({ mode: 'legacy', env: legacy, admission: await admission(first), intent: first });
    const second: MetadataIntent = { ...first, expectedHead: before.revision };
    const secondAdmission = await admission(second);
    const after = await measureEditionCommand({ mode: 'slim', env: slim, admission: secondAdmission, intent: second });
    const measurement = { qaRunId: apps.REZICS_QA_RUN_ID, ...compareEditionCommands(before, after) };
    mkdirSync(resolve('.temp'), { recursive: true });
    writeFileSync(resolve('.temp/slim-command-measure.json'), `${JSON.stringify(measurement, null, 2)}\n`);
    console.info('Slim edition measurement', JSON.stringify(measurement));
    expect(after.persistedQuads).toBeLessThan(before.persistedQuads);
    expect(after.serializedNQuadsBytes).toBeLessThan(before.serializedNQuadsBytes);
    expect(after.proofQuads).toBe(6);
    expect(after.defaultGraphQuads).toBeGreaterThan(0);
    expect(await textUnits()).toEqual(beforeText);
    const collectionHeads = (await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?graph ?revision WHERE { GRAPH ?graph { ${iri(work)} rv:editionsRevision ?revision } }`)).results!.bindings;
    writeFileSync(resolve('.temp/slim-collection-heads.json'), `${JSON.stringify(collectionHeads, null, 2)}\n`);
    expect(collectionHeads.filter(row => row.graph?.value === GRAPHS.current).map(row => row.revision!.value))
      .toEqual([after.revision]);
    const custodyRow = async (receipt: string) => (await fixture.accessPool.query<{
      payload_sha256: string; payload: Buffer; terminal: { receipt: string; revision: string; sequence: string; streamSequence: string } | null;
      outbox: { eventCount: number } | null; reconciled_at: Date | null; retired_at: Date | null;
    }>('SELECT payload_sha256,payload,terminal,outbox,reconciled_at,retired_at FROM access.command_custody WHERE receipt = $1', [receipt])).rows[0];
    const proofCount = async (receipt: string) => (await fuseki.query(`SELECT ?predicate ?object WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?predicate ?object } }`)).results!.bindings.length;
    const secondRow = (await custodyRow(after.receipt))!;
    expect(secondRow.terminal).toMatchObject({ receipt: after.receipt, revision: after.revision });
    expect(secondRow.outbox?.eventCount).toBe(1);

    // A real unrelated header command commits after the edition fixed its sequence basis.
    const racing: MetadataIntent = { ...second, expectedHead: after.revision };
    const racingAdmission = await admission(racing);
    const changedHeader: MetadataIntent = { ...header, expectedHead: headerHead,
      state: checkedMetadataState({ kind: 'header', originalTitle: { value: 'Slim edition measurement', language: 'en' },
        localized: [{ language: 'en', title: null, description: 'A concurrent edit', mainVersionLabel: null }] }) };
    const concurrentAdmission = await admission(changedHeader);
    beforeSlim = async () => {
      expect(await commitMetadata(legacy, concurrentAdmission, changedHeader)).toBe(true);
      headerHead = (await readMetadataReceipt(legacy, concurrentAdmission.id))!.revision!;
    };
    expect(await commitMetadata(slim, racingAdmission, racing)).toBe(false);
    expect(dispatched.some(entry => entry.envelope.receipt === workEditReceiptIri(racingAdmission.id)
      && entry.result.status === 'guard-unmatched')).toBe(true);
    expect((await readMetadataReceipt(slim, racingAdmission.id))?.outcome).toBe('cancelled');
    expect((await custodyRow(workEditReceiptIri(racingAdmission.id)))?.terminal).toBeNull();

    for (const kind of ['policy', 'shacl'] as const) {
      const intent: MetadataIntent = { ...first, state: checkedMetadataState({ ...edition, id: nativeId() }) };
      const admitted = await admission(intent);
      const component = intent.state.kind === 'edition' ? intent.state.id : '';
      mutation = envelope => ({ ...envelope, update: envelope.update.replace('INSERT {', `INSERT {
        GRAPH ${iri(GRAPHS.current)} { ${kind === 'policy' ? `${iri(work)} rv:unrelated "denied" .`
          : `${iri(component)} rv:editionLanguage "ja" .`} }`) });
      await expect(commitMetadata(slim, admitted, intent)).rejects.toBeInstanceOf(CommandRejected);
      const rejected = dispatched.find(entry => entry.envelope.receipt === workEditReceiptIri(admitted.id)
        && entry.result.status === 'invalid');
      expect(rejected).toBeDefined();
      if (rejected?.result.status === 'invalid') {
        expect(String(rejected.result.report)).toContain(kind === 'policy' ? 'unrelated current facts' : 'MaxCountConstraintComponent');
      }
      expect((await custodyRow(workEditReceiptIri(admitted.id)))?.terminal).toBeNull();
      expect((await readMetadataReceipt(slim, admitted.id))?.outcome).toBe('cancelled');
    }

    const lost: MetadataIntent = { ...first, state: checkedMetadataState({ ...edition, id: nativeId() }) };
    const lostAdmission = await admission(lost);
    loseResponse = true;
    expect(await commitMetadata(slim, lostAdmission, lost)).toBe(true);
    const lostTerminal = (await readMetadataReceipt(slim, lostAdmission.id))!;
    const dispatchCount = dispatched.length;
    expect(await commitMetadata(slim, lostAdmission, lost)).toBe(false);
    expect(dispatched).toHaveLength(dispatchCount);
    expect(await readMetadataReceipt(slim, lostAdmission.id)).toEqual(lostTerminal);
    await custody.retire(lostTerminal.receipt);
    expect(await proofCount(lostTerminal.receipt)).toBe(0);
    lostHandoffReceipt = lostTerminal.receipt;

    // Real S3 deletion prevents signing retirement even though PostgreSQL already has a terminal.
    await objects.discard(secondRow.payload_sha256);
    await expect(custody.retire(after.receipt)).rejects.toBeInstanceOf(ObjectUnavailable);
    expect(await proofCount(after.receipt)).toBe(6);
    expect((await custodyRow(after.receipt))?.retired_at).toBeNull();
    expect(await objects.put(secondRow.payload)).toBe(secondRow.payload_sha256);
    await custody.retire(after.receipt);
    expect(await proofCount(after.receipt)).toBe(0);
    expect(await textUnits()).toEqual(beforeText);
    const afterRetirement = await editionCommandFootprint(fuseki, {
      work, component: after.component, revision: after.revision, receipt: after.receipt,
    });
    expect(afterRetirement.persistedQuads).toBe(after.persistedQuads - 6);
    writeFileSync(resolve('.temp/slim-command-measure.json'),
      `${JSON.stringify({ ...measurement, afterRetirement }, null, 2)}\n`);
    expect((await custodyRow(after.receipt))?.retired_at).not.toBeNull();
    expect(await readMetadataReceipt(slim, secondAdmission.id)).toMatchObject({ receipt: after.receipt, revision: after.revision });

    const interrupted: MetadataIntent = { ...first, state: checkedMetadataState({ ...edition, id: nativeId() }) };
    const interruptedAdmission = await admission(interrupted);
    const interruptedReceipt = workEditReceiptIri(interruptedAdmission.id);
    owner.fail = true;
    await expect(commitMetadata(slim, interruptedAdmission, interrupted)).rejects.toThrow('Owner reconciliation interrupted');
    expect(await proofCount(interruptedReceipt)).toBe(6);
    expect((await custodyRow(interruptedReceipt))?.terminal).toBeNull();
    await expect(custody.retire(interruptedReceipt)).rejects.toThrow('not been reconciled');
    owner.fail = false;
    // The existing relay reconciles a prepared owner row after a lost response,
    // and safely retries a crash after retaining events but before checkpointing.
    await expect(drain()).rejects.toThrow('Retained handoff response lost');
    expect(handoffCrashes).toBe(1);
    await drain();
    const recovered = await custody.resolve(interruptedReceipt);
    expect(recovered?.receipt).toBe(interruptedReceipt);
    expect((await custodyRow(interruptedReceipt))?.outbox?.eventCount).toBe(1);
    await custody.retire(interruptedReceipt);
    expect(await proofCount(interruptedReceipt)).toBe(0);
    const pendingFootprint = await editionCommandFootprint(fuseki, { work, component: recovered!.component,
      revision: recovered!.revision, receipt: interruptedReceipt });
    expect(pendingFootprint.namedGraphQuads).toBeLessThan(before.namedGraphQuads);

    const app = createMainApp(fuseki, { environment: slim, access: fixture.access, account: fixture.account.verifier,
      catalogueIntake: fixture.catalogueIntake });
    const read = await app.handle(new Request(`http://main.local/v1/works/${shortId(work)}/editions/${shortId(recovered!.component)}?actingSubject=${encodeURIComponent(fixture.actor)}`,
      { headers: { authorization: `Bearer ${fixture.account.tokenA}` } }));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ revision: recovered!.revision,
      record: { title: edition.kind === 'edition' ? edition.title : null } });

    const apiKey = randomUUID();
    const apiState = checkedMetadataState({ ...edition, id: nativeId() });
    const apiWrite = () => app.handle(new Request(`http://main.local/v1/works/${shortId(work)}/metadata`, {
      method: 'PUT', headers: { authorization: `Bearer ${fixture.account.tokenA}`,
        'content-type': 'application/json', 'idempotency-key': apiKey },
      body: JSON.stringify({ profile: 'work-metadata-details-v1', state: apiState,
        expectedHead: null, actingSubject: fixture.actor }),
    }));
    const apiTerminal = await fixture.json<{ receipt: string; revision: string; replayed: boolean }>(await apiWrite(), 200);
    expect(apiTerminal.replayed).toBe(false);
    expect((await custodyRow(apiTerminal.receipt))?.retired_at).not.toBeNull();
    expect(await proofCount(apiTerminal.receipt)).toBe(0);
    expect(await fixture.json(await apiWrite(), 200)).toMatchObject({ ...apiTerminal, replayed: true });
    const list = await app.handle(new Request(`http://main.local/v1/works/${shortId(work)}/editions?actingSubject=${encodeURIComponent(fixture.actor)}`,
      { headers: { authorization: `Bearer ${fixture.account.tokenA}` } }));
    expect(list.status).toBe(200);
    const listed = await list.json() as { items: { id: string; revision: string }[] };
    expect(listed.items).toContainEqual(expect.objectContaining({
      id: apiState.kind === 'edition' ? apiState.id : '', revision: apiTerminal.revision,
    }));
    await drain();

    const readDelivered = async (receipt: string) => {
      const rows = (await relay.query<{ sequence: string; envelope: DeliveredMainEvent }>(
        `SELECT sequence::text, envelope FROM relay.delivered_event
         WHERE stream_scope=$1 AND data_epoch=$2 AND envelope#>>'{data,receipt,id}'=$3`,
        [MAIN_RELAY_STREAM_SCOPE, slim.lineage.dataEpoch, receipt])).rows;
      expect(rows).toHaveLength(1);
      return rows[0]!;
    };
    const legacyDelivered = await readDelivered(before.receipt);
    for (const receipt of [after.receipt, lostTerminal.receipt, interruptedReceipt, apiTerminal.receipt]) {
      const delivered = await readDelivered(receipt);
      const retained = (await custodyRow(receipt))!.terminal!;
      expect(Object.keys(delivered.envelope.data.receipt).sort())
        .toEqual(Object.keys(legacyDelivered.envelope.data.receipt).sort());
      expect(delivered.sequence).toBe(retained.streamSequence);
      expect(delivered.envelope).toMatchObject({ type: 'com.rezics.work.metadata-changed.v1', data: {
        sourcePosition: { datasetId: 'product', dataEpoch: slim.lineage.dataEpoch, sequence: retained.sequence },
        relayPosition: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: slim.lineage.dataEpoch,
          sequence: retained.streamSequence }, receipt: { id: receipt, metadata: { work, revision: retained.revision } },
      } });
      expect(await proofCount(receipt)).toBe(0);
      expect(await new DiscoveryRefreshInputs(relay, relayConsumer).read({ dataEpoch: slim.lineage.dataEpoch,
        sequence: delivered.sequence }, (BigInt(delivered.sequence) - 1n).toString()))
        .toEqual({ works: [work], created: [] });
    }
    for (const rejected of [racingAdmission]) {
      expect((await relay.query(`SELECT 1 FROM relay.delivered_event
        WHERE envelope#>>'{data,receipt,id}'=$1 AND envelope->>'type' LIKE 'com.rezics.work.metadata-%'`,
      [workEditReceiptIri(rejected.id)])).rowCount).toBe(0);
    }

    // V2 keeps its existing language-bearing event contract. Its lost native
    // acknowledgement resolves before the API retires the proof; normal Feed
    // consumption then invalidates only this Work's indexed author history.
    const v2 = checkedEditionV2({ kind: 'edition', id: nativeId(), status: 'active',
      title: { value: 'Delivered multilingual edition', language: 'en' }, contentLanguages: ['en', 'ja'],
      titleLanguage: 'en', tracklistLanguage: null, originalLanguages: ['ja'], isTranslation: true,
      editionStatement: null, publisher: null, publicationYear: 2026, isbn13: null });
    const v2Key = randomUUID();
    loseResponse = true;
    const v2Write = () => app.handle(new Request(`http://main.local/v1/works/${shortId(work)}/metadata`, {
      method: 'PUT', headers: { authorization: `Bearer ${fixture.account.tokenA}`,
        'content-type': 'application/json', 'idempotency-key': v2Key },
      body: JSON.stringify({ profile: 'work-metadata-details-v2', state: v2, expectedHead: null,
        actingSubject: fixture.actor }),
    }));
    const v2Terminal = await fixture.json<{ receipt: string; revision: string }>(await v2Write(), 200);
    expect(await proofCount(v2Terminal.receipt)).toBe(0);
    const sentAfterV2 = dispatched.length;
    expect(await fixture.json(await v2Write(), 200)).toMatchObject({ ...v2Terminal, replayed: true });
    expect(dispatched).toHaveLength(sentAfterV2);
    await drain();
    const deliveredV2 = await readDelivered(v2Terminal.receipt);
    expect(deliveredV2.envelope).toMatchObject({ type: 'com.rezics.work.metadata-revised.v1', data: {
      receipt: { id: v2Terminal.receipt, work, component: v2.id, revision: v2Terminal.revision,
        contentLanguages: ['en', 'ja'] },
    } });
    const feedId = `urn:rezics:feed:slim:${randomUUID()}`;
    const unrelatedWork = nativeId();
    const foreignScope = 'urn:rezics:stream:other-owner';
    const foreignEvent = { ...deliveredV2.envelope, id: `urn:rezics:event:${randomUUID()}`,
      data: { ...deliveredV2.envelope.data, receipt: { ...deliveredV2.envelope.data.receipt, work: unrelatedWork },
        relayPosition: { streamScope: foreignScope, dataEpoch: slim.lineage.dataEpoch, sequence: deliveredV2.sequence } } };
    await relay.query(`INSERT INTO relay.delivered_event(source,event_id,data_epoch,sequence,envelope,stream_scope)
      VALUES($1,$2,$3,$4,$5,$6)`, [foreignEvent.source,foreignEvent.id,slim.lineage.dataEpoch,
      deliveredV2.sequence,JSON.stringify(foreignEvent),foreignScope]);
    for (const [id, target] of [[feedId, work], [feedId + ':other', unrelatedWork]]) {
      await fixture.accessPool.query(`INSERT INTO access.feed_item
      (data_epoch,id,sequence,kind,occurred_at,time_basis,best_key,group_bucket,group_key,group_leader,
       group_members,sort_time,target_indexed,work)
      VALUES($1,$2,1,'work',clock_timestamp(),'relay',0,$2,$2,true,ARRAY[$2],clock_timestamp(),true,$3)`,
      [slim.lineage.dataEpoch, id, target]);
    }
    const previousV2 = (BigInt(deliveredV2.sequence) - 1n).toString();
    expect(await new FeedStore(fixture.accessPool).projectTargets({} as never, relay,
      { data_epoch: slim.lineage.dataEpoch, sequence: previousV2 } as FeedCheckpoint, deliveredV2.sequence)).toBe(true);
    expect((await fixture.accessPool.query('SELECT work,after_id FROM access.feed_author_dirty WHERE data_epoch=$1',
      [slim.lineage.dataEpoch])).rows).toEqual([{ work, after_id: '' }]);
    expect((await fixture.accessPool.query<{ sequence: string }>(
      'SELECT sequence::text FROM access.feed_target_checkpoint WHERE data_epoch=$1', [slim.lineage.dataEpoch])).rows[0]?.sequence)
      .toBe(deliveredV2.sequence);

    const coverage = await relayCoverage(relay, relayConsumer);
    expect(coverage).toMatchObject({ streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: slim.lineage.dataEpoch });
    const lostDelivered = await readDelivered(lostTerminal.receipt);
    const inboxConsumer = `slim-inbox:${randomUUID()}`;
    const gap = { consumer: inboxConsumer, relayConsumer, dataEpoch: slim.lineage.dataEpoch,
      afterSequence: '0', throughSequence: coverage.sequence };
    const gapKey = randomUUID();
    expect(await reconcileRelayGap(relay, fixture.accessPool, gap, gapKey)).toMatchObject({ state: 'reconciled', disposition: 'rebuilt' });
    expect(await reconcileRelayGap(relay, fixture.accessPool, gap, gapKey)).toMatchObject({ state: 'reconciled', replayed: true });
    const inbox = (await fixture.accessPool.query<{ sequence: string; envelope: DeliveredMainEvent }>(
      `SELECT sequence::text,envelope FROM access.owner_consumer_replay
       WHERE consumer=$1 AND event_id=$2`, [inboxConsumer, lostDelivered.envelope.id])).rows;
    expect(inbox).toEqual([lostDelivered]);
    expect(await relayMainOutboxOnce(fuseki, relay, relayConsumer, { ownerOutbox: custody })).toBeNull();
  } finally { await Promise.all([relay.end(), fixture.close()]); }
}, 300_000);
