import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient, type CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { CLASSIFICATION_DIRECT_DECISION_PROFILE, classificationDecisionSlotIri }
  from '../../../services/main/src/modules/classification/decision.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../../../services/main/src/modules/classification/context.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE, classificationPropositionDigest, createClassificationProposition }
  from '../../../services/main/src/modules/classification/proposition.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { statementUpgradeEnvelope, statementUpgradeMarker }
  from '../../../services/main/src/modules/statement/populated-conversion.ts';
import { readStatement, resolveStatementAcceptancesAt } from '../../../services/main/src/modules/statement/read.ts';
import { STATEMENT_DECISION_PROFILE, STATEMENT_PROFILE }
  from '../../../services/main/src/modules/statement/schema.ts';
import { StatementSeek } from '../../../services/main/src/modules/statement/seek.ts';
import { statementUpgradeCurrent, upgradeStoredStatements }
  from '../../../services/main/src/modules/statement/upgrade.ts';
import { DATASET, GRAPHS, RV, activateMetadataWork, hash, initializeFreshGraph, iri, lit,
  metadataWorkRequestDigest, prepareComponent, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { readWorkComponentState } from '../../../services/main/src/modules/work/history.ts';
import { migrateAccess, qaStack, rootCommand, waitForFuseki, type QaStack }
  from '../fault-recovery/search-ops-support.ts';
import { nativeId } from './context-fixture.ts';

const root = resolve(import.meta.dir, '../../..');

/** Only the stopped disposable copy reconstructs retired storage. Its running
 * service always uses the unchanged product query/command assembler. */
async function loadStoppedCopy(stack: QaStack, update: string) {
  stack.runner.stop();
  stack.runner.offline(`exec 9>>/fuseki/databases/rezics/owner.lock
flock -n 9
cat > /tmp/statement-upgrade.ru <<'STATEMENT_UPGRADE'
${update}
STATEMENT_UPGRADE
java -Xmx512m -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar \
  tdb2.tdbupdate --loc=/fuseki/databases/rezics/tdb2 --update=/tmp/statement-upgrade.ru`);
  await stack.runner.start();
  await waitForFuseki(stack.apps.FUSEKI_URL!);
}

async function facts(fuseki: FusekiClient, graphs: readonly string[], subjects?: readonly string[]) {
  return (await fuseki.query(`SELECT ?graph ?subject ?predicate ?object WHERE {
    VALUES ?graph { ${graphs.map(iri).join(' ')} }
    ${subjects ? `VALUES ?subject { ${subjects.map(iri).join(' ')} }` : ''}
    GRAPH ?graph { ?subject ?predicate ?object }
  } ORDER BY ?graph ?subject ?predicate ?object`)).results!.bindings;
}

async function position(fuseki: FusekiClient) {
  const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?routing ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ;
      rv:routingEpoch ?routing ; rv:sequence ?sequence }
  }`)).results!.bindings;
  expect(rows).toHaveLength(1);
  return { dataEpoch: rows[0]!.epoch!.value, routingEpoch: rows[0]!.routing!.value,
    sequence: rows[0]!.sequence!.value };
}

test('product Statement upgrade retains populated history, replays a lost acknowledgment and releases covered writer fences', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through selected QA integration');
  const stack = qaStack(`statement-${randomUUID().slice(0, 12)}`);
  let pool: Pool | undefined;
  let env: WorkActivationEnvironment | undefined;
  try {
    await rootCommand(['stack:up', ...stack.args], 180_000);
    const apps = stack.apps;
    const fuseki = stack.fuseki;
    expect(stack.composeEnv.REZICS_STACK_RAW_UPDATE).toBe('0');
    expect(stack.runner.exec('cat /fuseki/fuseki-text.ttl'))
      .toBe(readFileSync(resolve(root, 'infra/jena/fuseki-text.ttl'), 'utf8'));
    const assertRawUpdateClosed = async () => {
      const response = await fetch(new URL('update', apps.FUSEKI_URL!), { method: 'POST',
        headers: { 'content-type': 'application/sparql-update',
          authorization: `Bearer ${apps.FUSEKI_MAINTENANCE_TOKEN}` },
        body: `INSERT DATA { GRAPH ${iri(GRAPHS.current)} { <urn:rezics:test:raw> <${RV}unsafe> true } }`,
        signal: AbortSignal.timeout(10_000) });
      expect(response.status).toBe(404);
    };
    await assertRawUpdateClosed();
    await migrateAccess(apps.ACCESS_DATABASE_URL!);
    pool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    env = { fuseki, objectDirectory: apps.MAIN_OBJECT_DIRECTORY!,
      lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! } };
    await initializeFreshGraph(fuseki, env.lineage);
    const actorA = nativeId(), actorB = nativeId();
    const admission = (scope: string, action: string, requestDigest: string): RegisteredAdmission => ({
      id: randomUUID(), principalId: randomUUID(), actingSubject: actorA, scope, action,
      idempotencyKey: randomUUID(), requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false,
    });
    const definition = async (label: string) => {
      const input = { label, actingSubject: actorA };
      const result = await createClassificationProposition(env!, admission('classification:define:global',
        'classification.proposition.define', classificationPropositionDigest(input)), input);
      expect(result.outcome).toBe('succeeded');
      return result;
    };
    const originalDefinition = await definition('Retained definition');
    const laterDefinition = await definition('Later different concept');
    const created = await activateMetadataWork(env, { title: 'Populated Statement upgrade',
      admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest('Populated Statement upgrade')) });
    expect(created.work).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
    const main = created.mainVersion!, work = created.work!;
    const sense = originalDefinition.definitions!.sense, concept = originalDefinition.definitions!.concept;
    const sourcePosition = await position(fuseki);
    const historicalEpoch = randomUUID();
    expect(historicalEpoch).not.toBe(sourcePosition.dataEpoch);
    const applications = [nativeId(), nativeId(), nativeId()].sort().map((application, index) => {
      const first = nativeId(), head = nativeId(), firstOperation = nativeId(), operation = nativeId();
      const proposer = index === 1 ? actorB : actorA;
      const outcome = index === 1 ? 'rejected' : 'accepted';
      const slot = classificationDecisionSlotIri(main, sense, GLOBAL_CLASSIFICATION_CONTEXT);
      const state = { work, mainVersion: main, sense, senseRevision: originalDefinition.revision!,
        context: GLOBAL_CLASSIFICATION_CONTEXT, proposer, decider: actorB, application, slot,
        policy: CLASSIFICATION_DIRECT_DECISION_PROFILE };
      const firstManifest = prepareComponent(env!.objectDirectory, application,
        { ...state, decision: first, outcome: 'accepted' }, CLASSIFICATION_DIRECT_DECISION_PROFILE);
      const manifest = prepareComponent(env!.objectDirectory, application,
        { ...state, decision: head, outcome, predecessor: first }, CLASSIFICATION_DIRECT_DECISION_PROFILE);
      return { application, first, head, operation, firstOperation, proposer, outcome, slot,
        sequence: String([19, 7, 13][index]), firstManifest, manifest,
        receipt: `urn:rezics:receipt:retained-classification:${hash(application)}` };
    });
    const chronological = [...applications].sort((a, b) => Number(BigInt(a.sequence) - BigInt(b.sequence)));
    const changedSenseHead = nativeId();
    const sourceDefinitionManifest = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(originalDefinition.revision!)} rv:manifest ?manifest }
    }`)).results!.bindings[0]!.manifest!.value;
    const sourceDefinitionState = await readWorkComponentState(env, sourceDefinitionManifest, sense,
      CLASSIFICATION_PROPOSITION_PROFILE);
    const changedSenseManifest = prepareComponent(env.objectDirectory, sense,
      { ...sourceDefinitionState, concept: laterDefinition.definitions!.concept }, CLASSIFICATION_PROPOSITION_PROFILE);
    const unrelatedMarker = `urn:rezics:maintenance:unrelated:${randomUUID()}`;
    await loadStoppedCopy(stack, `PREFIX rv: <${RV}>
      DELETE DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(sense)} rv:head ${iri(originalDefinition.revision!)} } };
      INSERT DATA {
        GRAPH ${iri(GRAPHS.current)} { ${iri(sense)} rv:head ${iri(changedSenseHead)} .
          ${applications.map(value => `${iri(value.application)} a rv:ClassificationApplication ;
            rv:targetMainVersion ${iri(main)} ; rv:sense ${iri(sense)} ; rv:applicationKey ${iri(value.slot)} ;
            rv:classificationContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:applicationChannel rv:Curated ;
            rv:applicationState rv:Active ; rv:proposer ${iri(value.proposer)} ; rv:decisionHead ${iri(value.head)} .`).join('\n')}
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(changedSenseHead)} a rv:RevisionAnchor ; rv:component ${iri(sense)} ;
            rv:predecessor ${iri(originalDefinition.revision!)} ; rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ;
            rv:manifest ${iri(`urn:rezics:sha256:${changedSenseManifest}`)} .
          ${applications.map(value => `${iri(value.first)} a rv:ClassificationDecision, rv:RevisionAnchor ;
            rv:component ${iri(value.application)} ; rv:application ${iri(value.application)} ;
            rv:outcome rv:Accepted ; rv:decidedBy ${iri(actorB)} ; rv:decisionBasis rv:GlobalCuratorReview ;
            rv:decisionPolicy ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
            rv:operation ${iri(value.firstOperation)} ; rv:dataEpoch ${lit(historicalEpoch)} ; rv:sequence 1 ;
            rv:datasetId ${iri(DATASET)} ; rv:shapeRevision ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
            rv:modelRevision ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
            rv:manifest ${iri(`urn:rezics:sha256:${value.firstManifest}`)} .
          ${iri(value.head)} a rv:ClassificationDecision, rv:RevisionAnchor ;
            rv:component ${iri(value.application)} ; rv:application ${iri(value.application)} ;
            rv:predecessor ${iri(value.first)} ; rv:decisionBasis rv:GlobalCuratorReview ;
            rv:decisionPolicy ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
            rv:outcome rv:${value.outcome === 'accepted' ? 'Accepted' : 'Rejected'} ; rv:decidedBy ${iri(actorB)} ;
            rv:operation ${iri(value.operation)} ; rv:dataEpoch ${lit(historicalEpoch)} ; rv:sequence ${value.sequence} ;
            rv:datasetId ${iri(DATASET)} ; rv:shapeRevision ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
            rv:modelRevision ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
            rv:manifest ${iri(`urn:rezics:sha256:${value.manifest}`)} .`).join('\n')}
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${applications.map(value => `${iri(value.receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
            rv:operation ${iri(value.operation)} ; rv:requestDigest ${lit(hash(value.head))} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(historicalEpoch)} ; rv:sequence ${value.sequence} ;
            rv:application ${iri(value.application)} ; rv:decision ${iri(value.head)} .`).join('\n')}
        }
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true .
          ${iri(unrelatedMarker)} rv:statementUpgradeFence true }
      }`);
    const heldControl = await facts(fuseki, [GRAPHS.control]);
    await expect(upgradeStoredStatements(env, pool)).rejects.toThrow('unrelated recovery fence');
    const acquire = statementUpgradeEnvelope(env, 'acquire');
    const deniedAcquire = await fuseki.command({ receipt: acquire.receipt, digest: acquire.digest,
      validations: [], deadlineMs: 30_000, update: `PREFIX rv: <${RV}> INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true .
          ${iri(acquire.marker)} rv:statementUpgradeFence true }
        GRAPH ${iri(GRAPHS.receipts)} { ${acquire.facts} }
      } WHERE { GRAPH ${iri(GRAPHS.control)} { ${acquire.control} }
        ${acquire.absent}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } } }` });
    expect(['guard-unmatched', 'invalid']).toContain(deniedAcquire.status);
    expect(await facts(fuseki, [GRAPHS.control])).toEqual(heldControl);
    expect(await facts(fuseki, [GRAPHS.receipts], [acquire.receipt])).toEqual([]);
    expect((await pool.query('SELECT open FROM access.recovery_fence WHERE id')).rows).toEqual([{ open: true }]);
    await loadStoppedCopy(stack, `PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:restoreHold true . ${iri(unrelatedMarker)} rv:statementUpgradeFence true } }`);

    const historicalSubjects = [originalDefinition.revision!, ...applications.flatMap(value => [value.first, value.head])];
    const originalHistory = await facts(fuseki, [GRAPHS.revisions], historicalSubjects);
    const originalApplications = await facts(fuseki, [GRAPHS.current], applications.map(value => value.application));
    const originalReceipts = await facts(fuseki, [GRAPHS.receipts]);
    const originalReceiptIds = [...new Set(originalReceipts.map(value => value.subject!.value))];
    const sourceManifests = applications.flatMap(value => [
      { application: value.application, manifest: value.firstManifest },
      { application: value.application, manifest: value.manifest },
    ]);
    const originalManifestStates = await Promise.all(sourceManifests.map(value => readWorkComponentState(env!,
      `urn:rezics:sha256:${value.manifest}`, value.application, CLASSIFICATION_DIRECT_DECISION_PROFILE)));
    const originalOutbox = await facts(fuseki, [GRAPHS.outbox]);
    const originalStream = await facts(fuseki, [GRAPHS.control], [MAIN_RELAY_STREAM_SCOPE]);
    expect(originalOutbox.length).toBeGreaterThan(0);
    expect(originalStream.some(value => value.predicate!.value === `${RV}streamSequence`)).toBe(true);
    const nativeCommand = fuseki.commandWithReceipt.bind(fuseki);
    let lostAcknowledgment: CommandEnvelope | undefined;
    fuseki.commandWithReceipt = async envelope => {
      const result = await nativeCommand(envelope);
      if (result.status !== 'committed') throw new Error(`Product Statement upgrade rejected: ${JSON.stringify(result)}`);
      if (!lostAcknowledgment && envelope.receipt.startsWith('urn:rezics:name-migration:statement-upgrade:convert:')) {
        expect(result.status).toBe('committed');
        lostAcknowledgment = envelope;
        throw new Error('injected lost Statement conversion acknowledgment');
      }
      return result;
    };
    await expect(upgradeStoredStatements(env, pool)).rejects.toThrow('injected lost Statement conversion acknowledgment');
    fuseki.commandWithReceipt = nativeCommand;
    expect(lostAcknowledgment).toBeDefined();
    expect((await pool.query('SELECT open FROM access.recovery_fence WHERE id')).rows).toEqual([{ open: false }]);
    const seek = new StatementSeek(pool, env);
    expect((await seek.coverage())?.complete).toBe(false);
    expect(await statementUpgradeCurrent(fuseki, env.lineage.dataEpoch, pool)).toBe(false);
    expect((await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:restoreHold true .
      ${iri(statementUpgradeMarker(env.lineage.dataEpoch))} rv:statementUpgradeFence true } }`)).boolean).toBe(true);
    const partiallyConverted = await facts(fuseki, [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts]);
    for (const capability of [undefined, apps.FUSEKI_COMMAND_TOKEN]) {
      const response = await fetch(new URL('command', apps.FUSEKI_URL!), { method: 'POST',
        headers: { 'content-type': 'application/json', ...(capability ? { authorization: `Bearer ${capability}` } : {}) },
        body: JSON.stringify(lostAcknowledgment), signal: AbortSignal.timeout(35_000) });
      expect(response.status).toBe(403);
    }
    expect(await facts(fuseki, [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts])).toEqual(partiallyConverted);
    const replay = await fuseki.command(lostAcknowledgment!);
    expect(replay).toEqual({ status: 'committed', position: {
      datasetId: DATASET, dataEpoch: sourcePosition.dataEpoch, sequence: sourcePosition.sequence,
    } });
    expect(await facts(fuseki, [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts])).toEqual(partiallyConverted);
    expect(await upgradeStoredStatements(env, pool)).toEqual({ status: 'complete', converted: 2, replayed: 1, noop: false });
    expect(await statementUpgradeCurrent(fuseki, env.lineage.dataEpoch, pool)).toBe(true);
    expect(await seek.coverage()).toEqual({ through_sequence: sourcePosition.sequence, complete: true });
    expect((await pool.query('SELECT open FROM access.recovery_fence WHERE id')).rows).toEqual([{ open: true }]);
    expect((await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
      { ${iri(DATASET)} rv:restoreHold true } UNION {
        ${iri(statementUpgradeMarker(env.lineage.dataEpoch))} rv:statementUpgradeFence true } } }`)).boolean).toBe(false);

    const converted = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?application ?statement ?speaker ?key
      ?revision ?revisionManifest ?decision ?decisionManifest ?slot ?predecessor ?operation ?epoch ?sequence ?outcome WHERE {
      VALUES ?application { ${applications.map(value => iri(value.application)).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?statement rv:migratedFrom ?application ; rv:speaker ?speaker ; rv:meaningKey ?key ; rv:head ?revision }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?revision rv:manifest ?revisionManifest ; rv:operation ?operation ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        ?decision a rv:StatementDecision ; rv:support ?statement ; rv:component ?slot ; rv:manifest ?decisionManifest ; rv:outcome ?outcome .
        OPTIONAL { ?decision rv:predecessor ?predecessor }
      }
    } ORDER BY ?sequence ?application`)).results!.bindings;
    expect(converted).toHaveLength(3);
    expect(new Set(converted.map(value => value.statement!.value)).size).toBe(3);
    expect(new Set(converted.map(value => value.key!.value)).size).toBe(1);
    expect(new Set(converted.map(value => value.slot!.value)).size).toBe(1);
    const slot = converted[0]!.slot!.value, meaningKey = converted[0]!.key!.value;
    expect((await fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:decisionHead ?head } }`)).results!.bindings)
      .toEqual([{ head: { type: 'uri', value: converted[2]!.decision!.value } }]);
    for (const [index, value] of chronological.entries()) {
      const convertedValue = converted[index]!;
      expect(convertedValue.speaker!.value).toBe(value.proposer);
      expect(convertedValue.operation!.value).toBe(value.operation);
      expect(convertedValue.epoch!.value).toBe(historicalEpoch);
      expect(convertedValue.sequence!.value).toBe(value.sequence);
      expect(convertedValue.predecessor ? [convertedValue.predecessor.value] : [])
        .toEqual(index ? [converted[index - 1]!.decision!.value] : []);
      expect(convertedValue.outcome!.value).toBe(`${RV}${value.outcome === 'accepted' ? 'Accepted' : 'Rejected'}`);
      expect(await readWorkComponentState(env, convertedValue.revisionManifest!.value,
        convertedValue.statement!.value, STATEMENT_PROFILE)).toMatchObject({
        speaker: value.proposer, recordedBy: actorB, migratedFrom: value.application,
        meaning: { value: { kind: 'resource', iri: concept }, interpretationDefinitions: [originalDefinition.revision!] },
      });
      expect(await readWorkComponentState(env, convertedValue.decisionManifest!.value, slot,
        STATEMENT_DECISION_PROFILE)).toMatchObject({ convertedFrom: value.head, decidedBy: actorB,
        outcome: value.outcome, support: [convertedValue.statement!.value],
        predecessor: index ? converted[index - 1]!.decision!.value : null });
      expect((await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(convertedValue.decision!.value)} rv:convertedFrom ${iri(value.head)} ; rv:operation ${iri(value.operation)} ;
          rv:dataEpoch ${lit(historicalEpoch)} ; rv:sequence ${value.sequence} ; rv:decidedBy ${iri(actorB)} }
        GRAPH ${iri(GRAPHS.current)} { ${iri(convertedValue.statement!.value)} rv:interpretationDefinition ${iri(originalDefinition.revision!)} .
          ${iri(sense)} rv:head ${iri(changedSenseHead)} } }`)).boolean).toBe(true);
      const read = await readStatement(env, convertedValue.statement!.value, async () => false);
      expect(read.export['http://www.w3.org/ns/prov#wasAttributedTo']).toEqual([{ '@id': value.proposer }]);
      expect(read.export[`${RV}head`]).toEqual([{ '@id': convertedValue.revision!.value,
        '@type': [`${RV}StatementRevision`, 'http://www.w3.org/ns/prov#Entity'],
        'http://www.w3.org/ns/prov#wasGeneratedBy': [{ '@id': value.operation,
          '@type': ['http://www.w3.org/ns/prov#Activity'],
          'http://www.w3.org/ns/prov#wasAssociatedWith': [{ '@id': actorB }] }] }]);
    }
    const sought = await seek.seek({ dataEpoch: sourcePosition.dataEpoch, sequence: sourcePosition.sequence }, main, null);
    expect(new Set(sought.candidates.map(value => value.statementId)))
      .toEqual(new Set(converted.map(value => value.statement!.value)));
    expect((await resolveStatementAcceptancesAt(env, [{ kind: 'qualified-fact', meaningKey }], { kind: 'global' },
      { dataEpoch: sourcePosition.dataEpoch, sequence: sourcePosition.sequence })).get(meaningKey)?.result)
      .toMatchObject({ state: 'accepted', decision: converted[2]!.decision!.value });
    expect(await facts(fuseki, [GRAPHS.revisions], historicalSubjects)).toEqual(originalHistory);
    expect(await facts(fuseki, [GRAPHS.current], applications.map(value => value.application))).toEqual(originalApplications);
    expect(await facts(fuseki, [GRAPHS.receipts], originalReceiptIds)).toEqual(originalReceipts);
    expect(await Promise.all(sourceManifests.map(value => readWorkComponentState(env!,
      `urn:rezics:sha256:${value.manifest}`, value.application, CLASSIFICATION_DIRECT_DECISION_PROFILE))))
      .toEqual(originalManifestStates);
    expect(await facts(fuseki, [GRAPHS.outbox])).toEqual(originalOutbox);
    expect(await facts(fuseki, [GRAPHS.control], [MAIN_RELAY_STREAM_SCOPE])).toEqual(originalStream);
    expect(await position(fuseki)).toEqual(sourcePosition);
    const finished = await facts(fuseki, [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts, GRAPHS.control]);
    expect(await fuseki.command(lostAcknowledgment!)).toEqual(replay);
    expect(await fuseki.command({ ...lostAcknowledgment!, update: `${lostAcknowledgment!.update}\n# changed replay template` }))
      .toEqual({ status: 'conflict' });
    expect(await fuseki.command({ ...lostAcknowledgment!, digest: hash('changed replay request') })).toEqual({ status: 'conflict' });
    expect(await upgradeStoredStatements(env, pool)).toEqual({ status: 'complete', converted: 0, replayed: 0, noop: true });
    expect(await facts(fuseki, [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts, GRAPHS.control])).toEqual(finished);
    expect(await seek.coverage()).toEqual({ through_sequence: sourcePosition.sequence, complete: true });
    await assertRawUpdateClosed();
  } finally {
    await pool?.end();
    if (env) rmSync(env.objectDirectory, { recursive: true, force: true });
    await rootCommand(['stack:reset', ...stack.args], 120_000);
  }
}, qaStartupTestTimeout(360_000));
