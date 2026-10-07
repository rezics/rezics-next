import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
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
import { checkedMetadataState, metadataDigest, type MetadataIntent } from '../../../services/main/src/modules/work/metadata-schema.ts';
import { GRAPHS, iri, lit, type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { workEditReceiptIri } from '../../../services/main/src/modules/work/edit.ts';
import { compareEditionCommands, editionCommandFootprint, measureEditionCommand } from '../../../scripts/load/slim-command-measure.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';

class ReconciliationFault implements ReceiptCustodyStore {
  fail = false;
  constructor(private readonly owner: ReceiptCustodyStore) {}
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
    expect(after.proofQuads).toBe(5);
    expect(after.defaultGraphQuads).toBeGreaterThan(0);
    expect(await textUnits()).toEqual(beforeText);
    const collectionHeads = (await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?graph ?revision WHERE { GRAPH ?graph { ${iri(work)} rv:editionsRevision ?revision } }`)).results!.bindings;
    writeFileSync(resolve('.temp/slim-collection-heads.json'), `${JSON.stringify(collectionHeads, null, 2)}\n`);
    expect(collectionHeads.filter(row => row.graph?.value === GRAPHS.current).map(row => row.revision!.value))
      .toEqual([after.revision]);
    const custodyRow = async (receipt: string) => (await fixture.accessPool.query<{
      payload_sha256: string; payload: Buffer; terminal: { receipt: string; revision: string; sequence: string } | null;
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

    // Real S3 deletion prevents signing retirement even though PostgreSQL already has a terminal.
    await objects.discard(secondRow.payload_sha256);
    await expect(custody.retire(after.receipt)).rejects.toBeInstanceOf(ObjectUnavailable);
    expect(await proofCount(after.receipt)).toBe(5);
    expect((await custodyRow(after.receipt))?.retired_at).toBeNull();
    expect(await objects.put(secondRow.payload)).toBe(secondRow.payload_sha256);
    await custody.retire(after.receipt);
    expect(await proofCount(after.receipt)).toBe(0);
    expect(await textUnits()).toEqual(beforeText);
    const afterRetirement = await editionCommandFootprint(fuseki, {
      work, component: after.component, revision: after.revision, receipt: after.receipt,
    });
    expect(afterRetirement.persistedQuads).toBe(after.persistedQuads - 5);
    writeFileSync(resolve('.temp/slim-command-measure.json'),
      `${JSON.stringify({ ...measurement, afterRetirement }, null, 2)}\n`);
    expect((await custodyRow(after.receipt))?.retired_at).not.toBeNull();
    expect(await readMetadataReceipt(slim, secondAdmission.id)).toMatchObject({ receipt: after.receipt, revision: after.revision });

    const interrupted: MetadataIntent = { ...first, state: checkedMetadataState({ ...edition, id: nativeId() }) };
    const interruptedAdmission = await admission(interrupted);
    const interruptedReceipt = workEditReceiptIri(interruptedAdmission.id);
    owner.fail = true;
    await expect(commitMetadata(slim, interruptedAdmission, interrupted)).rejects.toThrow('Owner reconciliation interrupted');
    expect(await proofCount(interruptedReceipt)).toBe(5);
    expect((await custodyRow(interruptedReceipt))?.terminal).toBeNull();
    await expect(custody.retire(interruptedReceipt)).rejects.toThrow('not been reconciled');
    owner.fail = false;
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
  } finally { await fixture.close(); }
}, 300_000);
