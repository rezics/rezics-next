import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FusekiClient, type CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { profileValidations } from '../../../services/main/src/infrastructure/profile.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';

const RV = 'https://rezics.com/vocab/';
const SCHEMA = 'https://schema.org/';
const CURRENT = 'urn:rezics:graph:current';
const REVISIONS = 'urn:rezics:graph:revisions';
const CONTROL = 'urn:rezics:graph:control';
const RECEIPTS = 'urn:rezics:graph:receipts';
const OUTBOX = 'urn:rezics:graph:outbox';
const DATASET = 'urn:rezics:dataset:product';
const iri = (value: string) => `<${value}>`;
const rv = (value: string) => iri(`${RV}${value}`);

function client() {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  return new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN!,
    Bun.env.FUSEKI_COMMAND_TOKEN!);
}

async function reset(fuseki: FusekiClient) {
  const epoch = `validation-${randomUUID()}`;
  await fuseki.update(`CLEAR SILENT GRAPH ${iri(CURRENT)}; CLEAR SILENT GRAPH ${iri(REVISIONS)};
    CLEAR SILENT GRAPH ${iri(CONTROL)}; CLEAR SILENT GRAPH ${iri(RECEIPTS)};
    CLEAR SILENT GRAPH ${iri(OUTBOX)};
    INSERT DATA { GRAPH ${iri(CONTROL)} { ${iri(DATASET)} ${rv('dataEpoch')} ${JSON.stringify(epoch)} ;
      ${rv('routingEpoch')} "1" ; ${rv('sequence')} 0 . } }`);
  return epoch;
}

function envelope(epoch: string, deleted: string, checked: CommandEnvelope['validations'],
  inserted = ''): CommandEnvelope {
  const receipt = `urn:rezics:validation:${randomUUID()}`;
  const batch = `urn:rezics:outbox:validation:${randomUUID()}`;
  const event = `urn:rezics:event:validation:${randomUUID()}`;
  const digest = randomUUID();
  return { receipt, digest, deadlineMs: 10_000, validations: checked,
    update: `PREFIX rv: ${iri(RV)}
      DELETE { GRAPH ${iri(CONTROL)} { ${iri(DATASET)} rv:sequence 0 . }
        GRAPH ${iri(CURRENT)} { ${deleted} } }
      INSERT { GRAPH ${iri(CONTROL)} { ${iri(DATASET)} rv:sequence 1 . }
        ${inserted ? `GRAPH ${iri(CURRENT)} { ${inserted} }` : ''}
        GRAPH ${iri(RECEIPTS)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:requestDigest ${JSON.stringify(digest)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${JSON.stringify(epoch)} ; rv:sequence 1 ; rv:outcome rv:Succeeded . }
        GRAPH ${iri(OUTBOX)} { ${iri(batch)} a rv:OutboxBatch ;
          rv:dataEpoch ${JSON.stringify(epoch)} ; rv:sequence 1 ; rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:ModelProbeEvent ; rv:ordinal 0 ; rv:receipt ${iri(receipt)} . } }
      WHERE { GRAPH ${iri(CONTROL)} { ${iri(DATASET)} rv:dataEpoch ${JSON.stringify(epoch)} ;
        rv:routingEpoch "1" ; rv:sequence 0 . }
        GRAPH ${iri(CURRENT)} { ${deleted} }
        FILTER NOT EXISTS { GRAPH ${iri(RECEIPTS)} { ${iri(receipt)} ?p ?o } } }` };
}

async function has(fuseki: FusekiClient, graph: string, triple: string) {
  return (await fuseki.query(`ASK { GRAPH ${iri(graph)} { ${triple} } }`)).boolean === true;
}

test('MODEL15: removing a Context discriminator cannot fall through to its weaker profile', async () => {
  const fuseki = client();
  expect((await fuseki.commandHealth()).profiles['context-v1']).toBe(profileRegistry['context-v1'].sha256);
  const epoch = await reset(fuseki);
  const context = `urn:rezics:validation:context:${randomUUID()}`;
  const head = `urn:rezics:validation:semantic-head:${randomUUID()}`;
  const role = `${iri(context)} ${rv('contextRole')} ${rv('GlobalInterpretation')} .`;
  await fuseki.update(`INSERT DATA { GRAPH ${iri(CURRENT)} {
    ${iri(context)} a ${rv('SemanticContext')} ; ${rv('semanticHead')} ${iri(head)} ;
      ${rv('contextRole')} ${rv('GlobalInterpretation')} ; ${rv('contextState')} ${rv('Active')} ;
      ${rv('disclosure')} ${rv('Public')} . }
    GRAPH ${iri(REVISIONS)} { ${iri(head)} a ${rv('ContextSemanticRevision')} . } }`);
  const checked = await profileValidations(fuseki, 'context-v1', [{
    shape: 'https://rezics.com/definition/context-v1/context-shape',
    focus: [context], graphs: [CURRENT],
  }]);
  const command = envelope(epoch, role, checked);
  const result = await fuseki.commandWithReceipt(command);
  expect(result.status).toBe('invalid');
  expect(String('report' in result ? result.report : '')).toContain('prestate canonical selector changed');
  expect(await has(fuseki, CURRENT, role)).toBe(true);
  expect(await has(fuseki, RECEIPTS, `${iri(command.receipt)} ?p ?o`)).toBe(false);
  expect(await has(fuseki, OUTBOX, `?batch ?p ${iri(command.receipt)}`)).toBe(false);
}, 90_000);

test('MODEL15: switching a Context selector cannot use the poststate profile alone', async () => {
  const fuseki = client();
  const epoch = await reset(fuseki);
  const context = `urn:rezics:validation:context:${randomUUID()}`;
  const head = `urn:rezics:validation:semantic-head:${randomUUID()}`;
  const oldRole = `${iri(context)} ${rv('contextRole')} ${rv('GlobalInterpretation')} .`;
  const nextRole = `${iri(context)} ${rv('contextRole')} ${rv('SharedInterpretation')} .`;
  await fuseki.update(`INSERT DATA { GRAPH ${iri(CURRENT)} {
    ${iri(context)} a ${rv('SemanticContext')} ; ${rv('semanticHead')} ${iri(head)} ;
      ${rv('contextRole')} ${rv('GlobalInterpretation')} ; ${rv('contextState')} ${rv('Active')} ;
      ${rv('disclosure')} ${rv('Public')} . }
    GRAPH ${iri(REVISIONS)} { ${iri(head)} a ${rv('ContextSemanticRevision')} . } }`);
  const checked = await profileValidations(fuseki, 'context-v1', [{
    shape: 'https://rezics.com/definition/context-v1/context-shape',
    focus: [context], graphs: [CURRENT],
  }]);
  const command = envelope(epoch, oldRole, checked, nextRole);
  const result = await fuseki.commandWithReceipt(command);
  expect(result.status).toBe('invalid');
  expect(String('report' in result ? result.report : '')).toContain('prestate canonical selector changed');
  expect(await has(fuseki, CURRENT, oldRole)).toBe(true);
  expect(await has(fuseki, CURRENT, nextRole)).toBe(false);
  expect(await has(fuseki, RECEIPTS, `${iri(command.receipt)} ?p ?o`)).toBe(false);
}, 90_000);

test('MODEL15: removing RouteBinding state requires a lifecycle successor', async () => {
  const fuseki = client();
  const epoch = await reset(fuseki);
  const route = `urn:rezics:validation:route:${randomUUID()}`;
  const revision = `urn:rezics:validation:route-revision:${randomUUID()}`;
  const state = `${iri(route)} ${rv('routeState')} ${rv('Current')} .`;
  await fuseki.update(`INSERT DATA { GRAPH ${iri(CURRENT)} {
    ${iri(route)} a ${rv('RouteBinding')} ; ${rv('routeNamespace')} "work" ;
      ${rv('normalizedSlug')} "model15-route" ;
      ${rv('targetWork')} <https://example.org/rezics-test/work> ;
      ${rv('routeState')} ${rv('Current')} ; ${rv('routeRevision')} ${iri(revision)} . } }`);
  const checked = await profileValidations(fuseki, 'work-address-claim-v1', [{
    shape: 'https://rezics.com/definition/work-address-claim-v1/binding-shape',
    focus: [route], graphs: [CURRENT],
  }]);
  const command = envelope(epoch, state, checked);
  const result = await fuseki.commandWithReceipt(command);
  expect(result.status).toBe('invalid');
  expect(String('report' in result ? result.report : '')).toContain('prestate canonical selector changed');
  expect(await has(fuseki, CURRENT, state)).toBe(true);
  expect(await has(fuseki, RECEIPTS, `${iri(command.receipt)} ?p ?o`)).toBe(false);
}, 90_000);

test('MODEL15: RouteBinding accepts an exact lifecycle successor', async () => {
  const fuseki = client();
  const epoch = await reset(fuseki);
  const route = `urn:rezics:validation:route:${randomUUID()}`;
  const prior = `urn:rezics:validation:route-revision:${randomUUID()}`;
  const next = `urn:rezics:validation:route-revision:${randomUUID()}`;
  const target = 'https://example.org/rezics-test/work';
  await fuseki.update(`INSERT DATA { GRAPH ${iri(CURRENT)} {
    ${iri(route)} a ${rv('RouteBinding')} ; ${rv('routeNamespace')} "work" ;
      ${rv('normalizedSlug')} "model15-route" ; ${rv('targetWork')} ${iri(target)} ;
      ${rv('routeState')} ${rv('Current')} ; ${rv('routeRevision')} ${iri(prior)} . } }`);
  const checked = await profileValidations(fuseki, 'work-address-lifecycle-v1', [
    { shape: 'https://rezics.com/definition/work-address-lifecycle-v1/redirect-shape',
      focus: [route], graphs: [CURRENT] },
    { shape: 'https://rezics.com/definition/work-address-lifecycle-v1/revision-shape',
      focus: [next], graphs: [REVISIONS] },
  ]);
  const receipt = `urn:rezics:validation:${randomUUID()}`;
  const batch = `urn:rezics:outbox:validation:${randomUUID()}`;
  const event = `urn:rezics:event:validation:${randomUUID()}`;
  const digest = randomUUID();
  const command: CommandEnvelope = { receipt, digest, deadlineMs: 10_000, validations: checked,
    update: `PREFIX rv: ${iri(RV)}
      DELETE { GRAPH ${iri(CONTROL)} { ${iri(DATASET)} rv:sequence 0 . }
        GRAPH ${iri(CURRENT)} { ${iri(route)} rv:routeState rv:Current ; rv:routeRevision ${iri(prior)} . } }
      INSERT { GRAPH ${iri(CONTROL)} { ${iri(DATASET)} rv:sequence 1 . }
        GRAPH ${iri(CURRENT)} { ${iri(route)} rv:routeState rv:Redirected ;
          rv:routeRevision ${iri(next)} ; rv:redirectWork ${iri(target)} . }
        GRAPH ${iri(REVISIONS)} { ${iri(next)} a rv:RevisionAnchor ;
          rv:component ${iri(route)} ; rv:targetWork ${iri(target)} ;
          rv:normalizedSlug "model15-route" ; rv:previousRevision ${iri(prior)} ;
          rv:redirectWork ${iri(target)} ; rv:routeState rv:Redirected ;
          rv:routeChangeKind rv:Renamed ;
          rv:modelRevision <https://rezics.com/definition/work-address-lifecycle-v1> ;
          rv:shapeRevision <https://rezics.com/definition/work-address-lifecycle-v1> . }
        GRAPH ${iri(RECEIPTS)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:requestDigest ${JSON.stringify(digest)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${JSON.stringify(epoch)} ; rv:sequence 1 ; rv:outcome rv:Succeeded ;
          rv:sourceAddress ${iri(route)} ; rv:sourceRevision ${iri(next)} . }
        GRAPH ${iri(OUTBOX)} { ${iri(batch)} a rv:OutboxBatch ;
          rv:dataEpoch ${JSON.stringify(epoch)} ; rv:sequence 1 ; rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:ModelProbeEvent ; rv:ordinal 0 ; rv:receipt ${iri(receipt)} . } }
      WHERE { GRAPH ${iri(CONTROL)} { ${iri(DATASET)} rv:dataEpoch ${JSON.stringify(epoch)} ;
        rv:routingEpoch "1" ; rv:sequence 0 . }
        GRAPH ${iri(CURRENT)} { ${iri(route)} rv:routeState rv:Current ;
          rv:routeRevision ${iri(prior)} . }
        FILTER NOT EXISTS { GRAPH ${iri(RECEIPTS)} { ${iri(receipt)} ?p ?o } } }` };
  expect((await fuseki.commandWithReceipt(command)).status).toBe('committed');
  expect(await has(fuseki, RECEIPTS, `${iri(receipt)} ${rv('sourceRevision')} ${iri(next)} .`)).toBe(true);
  expect(await has(fuseki, CURRENT, `${iri(route)} ${rv('routeState')} ${rv('Redirected')} .`)).toBe(true);
}, 90_000);

test('MODEL16: changing a ClassificationContext type revalidates an untouched DecisionSlot', async () => {
  const fuseki = client();
  const epoch = await reset(fuseki);
  const context = `urn:rezics:validation:classification:${randomUUID()}`;
  const main = `urn:rezics:validation:main:${randomUUID()}`;
  const slot = `urn:rezics:validation:decision-slot:${randomUUID()}`;
  const decision = `urn:rezics:validation:decision:${randomUUID()}`;
  const removed = `${iri(context)} a ${rv('ClassificationContext')} .`;
  await fuseki.update(`INSERT DATA { GRAPH ${iri(CURRENT)} {
    ${iri(context)} a ${iri(`${SCHEMA}CreativeWork`)}, ${rv('ClassificationContext')} ;
      ${rv('mainVersion')} ${iri(main)} ;
      ${rv('continuityProfile')} <https://example.org/rezics-test/continuity-v1> ;
      ${rv('contextRole')} ${rv('GlobalClassification')} ;
      ${rv('contextState')} ${rv('Active')} ;
      ${rv('inheritancePolicy')} <https://rezics.com/definition/classification-isolate-v1> .
    ${iri(main)} a ${rv('MainVersion')} ; ${rv('work')} ${iri(context)} ;
      ${rv('hostingPolicy')} ${rv('MetadataOnly')} .
    ${iri(slot)} a ${rv('DecisionSlot')} ; ${rv('acceptanceContext')} ${iri(context)} ;
      ${rv('decisionHead')} ${iri(decision)} ; ${rv('targetKind')} ${rv('QualifiedFactTarget')} ;
      ${rv('decisionTarget')} <https://example.org/rezics-test/fact> . }
    GRAPH ${iri(REVISIONS)} { ${iri(decision)} a ${rv('StatementDecision')} . } }`);
  const checked = await profileValidations(fuseki, 'work-metadata-v1', [{
    shape: 'https://rezics.com/definition/work-metadata-v1/work-shape',
    focus: [context], graphs: [CURRENT],
  }]);
  const command = envelope(epoch, removed, checked);
  const result = await fuseki.commandWithReceipt(command);
  expect(result.status).toBe('invalid');
  expect(String('report' in result ? result.report : '')).toContain('acceptanceContext');
  expect(await has(fuseki, CURRENT, removed)).toBe(true);
  expect(await has(fuseki, RECEIPTS, `${iri(command.receipt)} ?p ?o`)).toBe(false);
  expect(await has(fuseki, OUTBOX, `?batch ?p ${iri(command.receipt)}`)).toBe(false);
}, 90_000);
