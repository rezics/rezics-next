import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FusekiClient, type CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { profileValidations } from '../../../services/main/src/infrastructure/profile.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';

const RV = 'https://rezics.com/vocab/';
const SCHEMA = 'https://schema.org/';
const CURRENT = 'urn:rezics:graph:current';
const CONTROL = 'urn:rezics:graph:control';
const RECEIPTS = 'urn:rezics:graph:receipts';
const OUTBOX = 'urn:rezics:graph:outbox';
const DATASET = 'urn:rezics:dataset:product';
const profile = profileRegistry['work-metadata-v1'];
const iri = (value: string) => `<${value}>`;

function subject() {
  const id = randomUUID();
  return { work: `https://example.org/rezics-test/work-${id}`,
    main: `https://example.org/rezics-test/main-${id}` };
}

function workTriples(value: ReturnType<typeof subject>) {
  return `${iri(value.work)} a ${iri(`${SCHEMA}CreativeWork`)} ;
    ${iri(`${RV}mainVersion`)} ${iri(value.main)} ;
    ${iri(`${RV}continuityProfile`)} <https://example.org/rezics-test/continuity-v1> .
    ${iri(value.main)} a ${iri(`${RV}MainVersion`)} ;
    ${iri(`${RV}work`)} ${iri(value.work)} ; ${iri(`${RV}hostingPolicy`)} ${iri(`${RV}MetadataOnly`)} .`;
}

async function validations(client: FusekiClient, value: ReturnType<typeof subject>) {
  return profileValidations(client, 'work-metadata-v1', [
    { shape: profile.shapes[0]!, focus: [value.work], graphs: [CURRENT] },
    { shape: profile.shapes[1]!, focus: [value.main], graphs: [CURRENT] },
  ]);
}

async function reset(client: FusekiClient) {
  const epoch = `validation-${randomUUID()}`;
  await client.update(`CLEAR SILENT GRAPH ${iri(CURRENT)}; CLEAR SILENT GRAPH ${iri(CONTROL)};
    CLEAR SILENT GRAPH ${iri(RECEIPTS)}; CLEAR SILENT GRAPH ${iri(OUTBOX)};
    INSERT DATA { GRAPH ${iri(CONTROL)} { ${iri(DATASET)} ${iri(`${RV}dataEpoch`)} ${JSON.stringify(epoch)} ;
      ${iri(`${RV}routingEpoch`)} "1" ; ${iri(`${RV}sequence`)} 0 . } }`);
  return epoch;
}

function envelope(epoch: string, data: string, checked: CommandEnvelope['validations'],
  deleteData = '', dataWhere = ''): CommandEnvelope {
  const receipt = `urn:rezics:validation:${randomUUID()}`;
  const batch = `urn:rezics:outbox:validation:${randomUUID()}`;
  const event = `urn:rezics:event:validation:${randomUUID()}`;
  const digest = randomUUID();
  return { receipt, digest, deadlineMs: 10_000, validations: checked,
    update: `PREFIX rv: ${iri(RV)}
      DELETE { GRAPH ${iri(CONTROL)} { ${iri(DATASET)} rv:sequence 0 . }
        ${deleteData ? `GRAPH ${iri(CURRENT)} { ${deleteData} }` : ''} }
      INSERT { GRAPH ${iri(CONTROL)} { ${iri(DATASET)} rv:sequence 1 . }
        ${data ? `GRAPH ${iri(CURRENT)} { ${data} }` : ''}
        GRAPH ${iri(RECEIPTS)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:requestDigest ${JSON.stringify(digest)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${JSON.stringify(epoch)} ; rv:sequence 1 ; rv:outcome rv:Succeeded . }
        GRAPH ${iri(OUTBOX)} { ${iri(batch)} a rv:OutboxBatch ;
          rv:dataEpoch ${JSON.stringify(epoch)} ; rv:sequence 1 ; rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:ModelProbeEvent ; rv:ordinal 0 ; rv:receipt ${iri(receipt)} . } }
      WHERE { GRAPH ${iri(CONTROL)} { ${iri(DATASET)} rv:dataEpoch ${JSON.stringify(epoch)} ;
        rv:routingEpoch "1" ; rv:sequence 0 . }
        ${dataWhere ? `GRAPH ${iri(CURRENT)} { ${dataWhere} }` : ''}
        FILTER NOT EXISTS { GRAPH ${iri(RECEIPTS)} { ${iri(receipt)} ?p ?o } } }` };
}

async function exists(client: FusekiClient, graph: string, item: string) {
  return (await client.query(`ASK { GRAPH ${iri(graph)} { ${iri(item)} ?p ?o } }`)).boolean === true;
}

test('MODEL15/MODEL16/MODEL17/MODEL18/MODEL23/MODEL27: native validation and guards roll back invalid changes', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const client = new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN!,
    Bun.env.FUSEKI_COMMAND_TOKEN!);
  expect((await client.commandHealth()).profiles['work-metadata-v1']).toBe(profile.sha256);

  const epoch = await reset(client);
  const work = subject();
  await client.update(`INSERT DATA { GRAPH ${iri(CURRENT)} { ${workTriples(work)} } }`);
  const removedType = `${iri(work.work)} a ${iri(`${SCHEMA}CreativeWork`)} .`;
  const removed = envelope(epoch, '', await validations(client, work), removedType, removedType);
  const removedResult = await client.commandWithReceipt(removed);
  expect(removedResult.status).toBe('invalid');
  expect(await exists(client, RECEIPTS, removed.receipt)).toBe(false);
  expect((await client.query(`ASK { GRAPH ${iri(CURRENT)} { ${removedType} } }`)).boolean).toBe(true);
  for (const selector of [
    `${iri(work.work)} ${iri(`${RV}mainVersion`)} ${iri(work.main)} .`,
    `${iri(work.work)} ${iri(`${RV}continuityProfile`)} <https://example.org/rezics-test/continuity-v1> .`,
  ]) {
    const removedSelector = envelope(epoch, '', await validations(client, work), selector, selector);
    expect((await client.commandWithReceipt(removedSelector)).status).toBe('invalid');
    expect(await exists(client, RECEIPTS, removedSelector.receipt)).toBe(false);
    expect((await client.query(`ASK { GRAPH ${iri(CURRENT)} { ${selector} } }`)).boolean).toBe(true);
  }

  // A child type change would also invalidate its referencing Work. The selected
  // parent shape sees the complete poststate, even though its own triples stay put.
  const childType = `${iri(work.main)} a ${iri(`${RV}MainVersion`)} .`;
  const changedChild = envelope(epoch, '', (await validations(client, work)).slice(0, 1),
    childType, childType);
  expect((await client.commandWithReceipt(changedChild)).status).toBe('invalid');
  expect(await exists(client, RECEIPTS, changedChild.receipt)).toBe(false);
  expect((await client.query(`ASK { GRAPH ${iri(CURRENT)} { ${childType} } }`)).boolean).toBe(true);

  const emptyFocus = envelope(epoch, `${iri(work.work)} ${iri(`${RV}scalarValue`)} rv:ExplicitNoValue .`, []);
  expect((await client.commandWithReceipt(emptyFocus)).status).toBe('invalid');
  expect(await exists(client, RECEIPTS, emptyFocus.receipt)).toBe(false);

  const unsupported = envelope(epoch, `${iri(work.work)} ${iri(`${RV}scalarValue`)} rv:ExplicitNoValue .`,
    [{ ...(await validations(client, work))[0]!, shape: 'urn:rezics:unsupported-shape' }]);
  expect((await client.commandWithReceipt(unsupported)).status).toBe('unknown-profile');
  expect(await exists(client, RECEIPTS, unsupported.receipt)).toBe(false);

  // A prepared negative read must be checked again by the writing transaction.
  // Fault injection inserts the absent slot without advancing the command head.
  const slot = `urn:rezics:validation:slot:${randomUUID()}`;
  const slotTriple = `${iri(slot)} ${iri(`${RV}member`)} ${iri(work.work)} .`;
  const absent = envelope(epoch, `${iri(work.work)} ${iri(`${RV}scalarValue`)} rv:ExplicitUnknown .`,
    await validations(client, work));
  absent.update = absent.update.replace('FILTER NOT EXISTS { GRAPH',
    `FILTER NOT EXISTS { GRAPH ${iri(CURRENT)} { ${iri(slot)} ${iri(`${RV}member`)} ?dependent } } FILTER NOT EXISTS { GRAPH`);
  await client.update(`INSERT DATA { GRAPH ${iri(CURRENT)} { ${slotTriple} } }`);
  expect((await client.commandWithReceipt(absent)).status).toBe('guard-unmatched');
  expect(await exists(client, RECEIPTS, absent.receipt)).toBe(false);

  const raceEpoch = await reset(client);
  const first = subject(), second = subject();
  const a = envelope(raceEpoch, workTriples(first), await validations(client, first));
  const b = envelope(raceEpoch, workTriples(second), await validations(client, second));
  const outcomes = await Promise.all([client.commandWithReceipt(a), client.commandWithReceipt(b)]);
  expect(outcomes.filter(result => result.status === 'committed')).toHaveLength(1);
  expect([await exists(client, RECEIPTS, a.receipt), await exists(client, RECEIPTS, b.receipt)].sort())
    .toEqual([false, true]);
  expect([await exists(client, CURRENT, first.work), await exists(client, CURRENT, second.work)].sort())
    .toEqual([false, true]);
  const batchCount = await client.query(`PREFIX rv: ${iri(RV)} SELECT (COUNT(?batch) AS ?count) WHERE {
    GRAPH ${iri(OUTBOX)} { ?batch a rv:OutboxBatch } }`);
  expect(batchCount.results?.bindings[0]?.count?.value).toBe('1');

  const partialEpoch = await reset(client);
  const third = subject(), fourth = subject();
  const partial = envelope(partialEpoch, `${workTriples(third)} ${workTriples(fourth)}`,
    await validations(client, third));
  expect((await client.commandWithReceipt(partial)).status).toBe('invalid');
  expect(await exists(client, RECEIPTS, partial.receipt)).toBe(false);
  expect(await exists(client, CURRENT, third.work)).toBe(false);
  expect(await exists(client, CURRENT, fourth.work)).toBe(false);
}, 90_000);
