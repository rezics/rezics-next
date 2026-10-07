import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { type CommandEnvelope, FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../../../services/main/src/modules/classification/context.ts';
import { CLASSIFICATION_DIRECT_DECISION_PROFILE, classificationDecisionDigest,
  classificationDecisionReceiptIri, classificationDecisionSlotIri }
  from '../../../services/main/src/modules/classification/decision.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE, classificationPropositionDigest, createClassificationProposition }
  from '../../../services/main/src/modules/classification/proposition.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { relayCoverage, type MainCloudEvent } from '../../../services/main/src/modules/outbox/relay.ts';
import { STATEMENT_DECISION_PROFILE, STATEMENT_PROFILE }
  from '../../../services/main/src/modules/statement/schema.ts';
import { DATASET, GRAPHS, RV, activateMetadataWork, hash, initializeFreshGraph, iri, lit,
  metadataWorkRequestDigest, prepareComponent, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { readWorkComponentState } from '../../../services/main/src/modules/work/history.ts';
import { reconcileRetainedClassificationDecision }
  from '../../../services/main/src/modules/work/reconcile-restored.ts';
import { migrateAccess, qaStack, rootCommand, waitForFuseki, type QaStack }
  from '../fault-recovery/search-ops-support.ts';
import { nativeId } from './context-fixture.ts';

const root = resolve(import.meta.dir, '../../..');

/** Retired state is reconstructed only while this disposable product copy is stopped. */
async function loadStoppedCopy(stack: QaStack, update: string) {
  stack.runner.stop();
  stack.runner.offline(`exec 9>>/fuseki/databases/rezics/owner.lock
flock -n 9
cat > /tmp/classification-restore.ru <<'CLASSIFICATION_RESTORE'
${update}
CLASSIFICATION_RESTORE
java -Xmx512m -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar \\
  tdb2.tdbupdate --loc=/fuseki/databases/rezics/tdb2 --update=/tmp/classification-restore.ru`);
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

test('product classification restore preserves retained meaning and decision CAS through interruption and lost acknowledgment', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through selected QA integration');
  const stack = qaStack(`classification-${randomUUID().slice(0, 12)}`);
  let accessPool: Pool | undefined, relayPool: Pool | undefined;
  let env: WorkActivationEnvironment | undefined;
  try {
    rootCommand(['stack:up', ...stack.args], 180_000);
    const apps = stack.apps, fuseki = stack.fuseki;
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
    accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    relayPool = new Pool({ connectionString: apps.MAIN_RELAY_DATABASE_URL });
    for (const file of schemaFiles(root, 'relay')) {
      await relayPool.query(readFileSync(resolve(root, 'services/main/migrations/relay', file), 'utf8'));
    }
    env = { fuseki, objectDirectory: apps.MAIN_OBJECT_DIRECTORY!,
      lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! } };
    await initializeFreshGraph(fuseki, env.lineage);
    const actor = nativeId(), proposer = nativeId(), principal = randomUUID();
    const admission = (scope: string, action: string, requestDigest: string): RegisteredAdmission => ({
      id: randomUUID(), principalId: principal, actingSubject: actor, scope, action,
      idempotencyKey: randomUUID(), requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false,
    });
    const define = async (label: string) => {
      const input = { label, actingSubject: actor };
      const result = await createClassificationProposition(env!, admission('classification:define:global',
        'classification.proposition.define', classificationPropositionDigest(input)), input);
      expect(result.outcome).toBe('succeeded');
      return result;
    };
    const originalDefinition = await define('Exact retained classification');
    const laterDefinition = await define('Later different interpretation');
    const created = await activateMetadataWork(env, { title: 'Retained classification restore',
      admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest('Retained classification restore')) });
    const work = created.work!, main = created.mainVersion!;
    const sense = originalDefinition.definitions!.sense, concept = originalDefinition.definitions!.concept;
    const senseRevision = originalDefinition.revision!, changedSenseHead = nativeId();
    const sourceDefinitionManifest = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(senseRevision)} rv:manifest ?manifest }
    }`)).results!.bindings[0]!.manifest!.value;
    const sourceDefinitionState = await readWorkComponentState(env, sourceDefinitionManifest, sense,
      CLASSIFICATION_PROPOSITION_PROFILE);
    const changedSenseManifest = prepareComponent(env.objectDirectory, sense,
      { ...sourceDefinitionState, concept: laterDefinition.definitions!.concept }, CLASSIFICATION_PROPOSITION_PROFILE);
    const application = nativeId(), legacySlot = classificationDecisionSlotIri(main, sense, GLOBAL_CLASSIFICATION_CONTEXT);
    const historicalEpoch = randomUUID(), restoredEpoch = randomUUID();
    const marker = `urn:rezics:restore:${restoredEpoch}`;
    const firstDecision = nativeId();
    const decisions = (['accepted', 'rejected'] as const).map((outcome, index) => {
      const decision = index ? nativeId() : firstDecision, predecessor = index ? firstDecision : null;
      const id = randomUUID(), operation = nativeId(), sequence = String(index + 1);
      const requestDigest = classificationDecisionDigest({ context: { kind: 'global' }, work,
        mainVersion: main, sense, expectedDecisionHead: predecessor, outcome, actingSubject: actor });
      const manifest = `urn:rezics:sha256:${prepareComponent(env!.objectDirectory, application, {
        application, slot: legacySlot, work, mainVersion: main, sense, senseRevision,
        context: GLOBAL_CLASSIFICATION_CONTEXT, realm: null, contextRevision: null,
        decision, predecessor, outcome, proposer, decider: actor,
        policy: CLASSIFICATION_DIRECT_DECISION_PROFILE,
      }, CLASSIFICATION_DIRECT_DECISION_PROFILE)}`;
      const receipt = classificationDecisionReceiptIri(id), eventId = `urn:rezics:event:${hash(operation)}`;
      const batchId = `urn:rezics:outbox:${hash(receipt)}`;
      const envelope: MainCloudEvent = { specversion: '1.0', id: eventId,
        source: 'https://rezics.com/services/main', type: 'com.rezics.classification.decision-changed.v1',
        datacontenttype: 'application/json', data: { batchId,
          sourcePosition: { datasetId: 'product', dataEpoch: historicalEpoch, sequence },
          routingEpoch: env!.lineage.routingEpoch, ordinal: 0,
          receipt: { id: receipt, admissionId: id, action: 'classification.decision.set',
            outcome: 'succeeded', requestDigest, authorityEpoch: '7', scope: 'classification:decide:global',
            operation, work, mainVersion: main, sense, classificationContext: GLOBAL_CLASSIFICATION_CONTEXT,
            slot: legacySlot, application, decision, decisionManifest: manifest, decisionOutcome: outcome,
            ...(predecessor ? { expectedHead: predecessor } : {}) } } };
      return { id, decision, predecessor, outcome, operation, sequence, requestDigest, manifest,
        receipt, eventId, batchId, envelope };
    });
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1::uuid, 'https://account.rezics.test', $1::text)`, [principal]);
    await accessPool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`, [actor]);
    await accessPool.query(`INSERT INTO access.scope_gate (id) VALUES ('classification:decide:global')`);
    for (const value of decisions) {
      // Expired sealed admissions prove the retained effect without issuing new authority.
      await accessPool.query(`INSERT INTO access.admission (id, principal_id, acting_subject, scope_id,
        action, idempotency_key, request_digest, authority_epoch, expires_at, state,
        graph_receipt, graph_outcome, graph_data_epoch, graph_sequence, sealed_at)
        VALUES ($1::uuid, $2, $3, 'classification:decide:global', 'classification.decision.set', $1::text,
          $4, 7, now() - interval '1 day', 'sealed', $5, 'succeeded', $6, $7, now())`,
      [value.id, principal, actor, value.requestDigest, value.receipt, historicalEpoch, value.sequence]);
      await relayPool.query(`INSERT INTO relay.delivered_batch
        (data_epoch, sequence, batch_id, routing_epoch, event_count) VALUES ($1, $2, $3, $4, 1)`,
      [historicalEpoch, value.sequence, value.batchId, env.lineage.routingEpoch]);
      await relayPool.query(`INSERT INTO relay.delivered_event
        (source, event_id, data_epoch, sequence, envelope) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [value.envelope.source, value.eventId, historicalEpoch, value.sequence, JSON.stringify(value.envelope)]);
    }
    const consumer = 'classification-restore';
    await relayPool.query(`INSERT INTO relay.checkpoint (consumer, data_epoch, sequence) VALUES ($1, $2, 2)`,
      [consumer, historicalEpoch]);
    const coverage = await relayCoverage(relayPool, consumer);
    expect(coverage).toMatchObject({ streamScope: MAIN_RELAY_STREAM_SCOPE,
      dataEpoch: historicalEpoch, sequence: '2', batchCount: '2', eventCount: '2' });
    const originalLineage = env.lineage;
    const originalSequence = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence }
    }`)).results!.bindings[0]!.sequence!.value;
    await loadStoppedCopy(stack, `PREFIX rv: <${RV}>
      DELETE DATA {
        GRAPH ${iri(GRAPHS.current)} { ${iri(sense)} rv:head ${iri(senseRevision)} }
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(originalLineage.dataEpoch)} ; rv:sequence ${originalSequence} }
      };
      INSERT DATA {
        GRAPH ${iri(GRAPHS.current)} { ${iri(sense)} rv:head ${iri(changedSenseHead)} }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(changedSenseHead)} a rv:RevisionAnchor ; rv:component ${iri(sense)} ;
            rv:predecessor ${iri(senseRevision)} ; rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ;
            rv:manifest ${iri(`urn:rezics:sha256:${changedSenseManifest}`)} . }
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(restoredEpoch)} ; rv:sequence 0 ;
          rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(historicalEpoch)} ; rv:priorSequence 0 . }
      }`);
    env.lineage = { ...originalLineage, dataEpoch: restoredEpoch };
    const allGraphs = [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts, GRAPHS.outbox, GRAPHS.control];
    const before = await facts(fuseki, allGraphs);
    const retainedDefinitions = await facts(fuseki, [GRAPHS.revisions], [senseRevision, changedSenseHead]);
    const originalReceipts = await facts(fuseki, [GRAPHS.receipts]);
    const originalReceiptIds = [...new Set(originalReceipts.map(value => value.subject!.value))];
    const originalStream = await facts(fuseki, [GRAPHS.control], [MAIN_RELAY_STREAM_SCOPE]);
    const reconcile = (sequence: string) => reconcileRetainedClassificationDecision(env!, accessPool!, relayPool!, coverage, sequence);
    await expect(reconcile('1')).rejects.toThrow('Access recovery fence is not held');
    expect(await facts(fuseki, allGraphs)).toEqual(before);
    await accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id');
    await accessPool.query('UPDATE access.admission SET authority_epoch = 8 WHERE id = $1', [decisions[0]!.id]);
    await expect(reconcile('1')).rejects.toThrow('current Access admission does not prove retained decision');
    expect(await facts(fuseki, allGraphs)).toEqual(before);
    await accessPool.query('UPDATE access.admission SET authority_epoch = 7 WHERE id = $1', [decisions[0]!.id]);

    const nativeCommand = fuseki.commandWithReceipt.bind(fuseki);
    let interrupted: CommandEnvelope | undefined;
    fuseki.commandWithReceipt = async envelope => {
      interrupted = envelope;
      throw new Error('injected interruption before classification restore command');
    };
    await expect(reconcile('1')).rejects.toThrow('retained classification decision update outcome is unknown');
    fuseki.commandWithReceipt = nativeCommand;
    expect(interrupted?.receipt).toStartWith('urn:rezics:name-migration:statement-upgrade:restore:');
    expect(await facts(fuseki, allGraphs)).toEqual(before);
    for (const capability of [undefined, apps.FUSEKI_COMMAND_TOKEN]) {
      const response = await fetch(new URL('command', apps.FUSEKI_URL!), { method: 'POST',
        headers: { 'content-type': 'application/json', ...(capability ? { authorization: `Bearer ${capability}` } : {}) },
        body: JSON.stringify(interrupted), signal: AbortSignal.timeout(35_000) });
      expect(response.status).toBe(403);
    }
    expect(await facts(fuseki, allGraphs)).toEqual(before);
    expect(await reconcile('1')).toEqual({ receipt: decisions[0]!.receipt, application,
      decision: firstDecision, replayed: false });
    const firstHistory = await facts(fuseki, [GRAPHS.revisions], [firstDecision]);
    const firstReceipt = await facts(fuseki, [GRAPHS.receipts], [decisions[0]!.receipt]);
    const firstNative = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?decision ?slot WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ?decision a rv:StatementDecision ; rv:convertedFrom ${iri(firstDecision)} ; rv:component ?slot }
    }`)).results!.bindings;
    expect(firstNative).toHaveLength(1);
    const nativeSlot = firstNative[0]!.slot!.value, nativeHead = firstNative[0]!.decision!.value;
    const staleHead = nativeId();
    let staleResult: string | undefined;
    fuseki.commandWithReceipt = async envelope => {
      // Mutate the actual slot after preparation to exercise the native graph CAS.
      await loadStoppedCopy(stack, `PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(nativeSlot)} rv:decisionHead ${iri(nativeHead)} } };
        INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(nativeSlot)} rv:decisionHead ${iri(staleHead)} } }`);
      const staleSnapshot = await facts(fuseki, allGraphs);
      const result = await nativeCommand(envelope);
      staleResult = result.status;
      expect(await facts(fuseki, allGraphs)).toEqual(staleSnapshot);
      return result;
    };
    await expect(reconcile('2')).rejects.toThrow('retained classification decision update outcome is unknown');
    fuseki.commandWithReceipt = nativeCommand;
    expect(staleResult).toBe('guard-unmatched');
    expect(await facts(fuseki, [GRAPHS.receipts], [decisions[1]!.receipt])).toEqual([]);
    await loadStoppedCopy(stack, `PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(nativeSlot)} rv:decisionHead ${iri(staleHead)} } };
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(nativeSlot)} rv:decisionHead ${iri(nativeHead)} } }`);

    let lostAcknowledgment: CommandEnvelope | undefined;
    fuseki.commandWithReceipt = async envelope => {
      const result = await nativeCommand(envelope);
      expect(result.status).toBe('committed');
      lostAcknowledgment = envelope;
      throw new Error('injected lost committed classification restore acknowledgment');
    };
    // The retained original receipt proves the commit despite the missing response.
    expect(await reconcile('2')).toEqual({ receipt: decisions[1]!.receipt, application,
      decision: decisions[1]!.decision, replayed: false });
    fuseki.commandWithReceipt = nativeCommand;
    expect(lostAcknowledgment?.receipt).toStartWith('urn:rezics:name-migration:statement-upgrade:restore:');
    const converted = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?statement ?revision ?manifest ?key
      ?decision ?decisionManifest ?convertedFrom ?outcome ?predecessor ?sequence WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?statement rv:migratedFrom ${iri(application)} ; rv:head ?revision ; rv:meaningKey ?key }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:manifest ?manifest .
        ?decision a rv:StatementDecision ; rv:component ${iri(nativeSlot)} ; rv:support ?statement ;
          rv:manifest ?decisionManifest ; rv:convertedFrom ?convertedFrom ; rv:outcome ?outcome ; rv:sequence ?sequence .
        OPTIONAL { ?decision rv:predecessor ?predecessor } }
    } ORDER BY ?sequence`)).results!.bindings;
    expect(converted).toHaveLength(2);
    expect(new Set(converted.map(value => value.statement!.value)).size).toBe(1);
    expect(new Set(converted.map(value => value.revision!.value)).size).toBe(1);
    for (const [index, value] of decisions.entries()) {
      const convertedValue = converted[index]!;
      expect(convertedValue.convertedFrom!.value).toBe(value.decision);
      expect(convertedValue.sequence!.value).toBe(value.sequence);
      expect(convertedValue.outcome!.value).toBe(`${RV}${value.outcome === 'accepted' ? 'Accepted' : 'Rejected'}`);
      expect(convertedValue.predecessor?.value ?? null).toBe(index ? nativeHead : null);
      expect(await readWorkComponentState(env, convertedValue.manifest!.value,
        convertedValue.statement!.value, STATEMENT_PROFILE)).toMatchObject({ speaker: proposer, recordedBy: actor,
        migratedFrom: application, meaning: { value: { kind: 'resource', iri: concept },
          interpretationDefinitions: [senseRevision] } });
      expect(await readWorkComponentState(env, convertedValue.decisionManifest!.value, nativeSlot,
        STATEMENT_DECISION_PROFILE)).toMatchObject({ convertedFrom: value.decision, outcome: value.outcome,
        predecessor: index ? nativeHead : null, decidedBy: actor, support: [convertedValue.statement!.value] });
      expect(await readWorkComponentState(env, value.manifest, application,
        CLASSIFICATION_DIRECT_DECISION_PROFILE)).toMatchObject({ decision: value.decision,
        predecessor: value.predecessor, senseRevision, outcome: value.outcome, proposer, decider: actor });
      expect((await fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(convertedValue.decision!.value)} rv:operation ${iri(value.operation)} ;
          rv:dataEpoch ${lit(historicalEpoch)} ; rv:sequence ${value.sequence} }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(value.receipt)} rv:operation ${iri(value.operation)} ;
          rv:requestDigest ${lit(value.requestDigest)} ; rv:authorityEpoch "7" ;
          rv:dataEpoch ${lit(historicalEpoch)} ; rv:sequence ${value.sequence} }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(value.batchId)} rv:eventCount 1 ; rv:event ${iri(value.eventId)} ;
          rv:dataEpoch ${lit(historicalEpoch)} ; rv:sequence ${value.sequence} .
          ${iri(value.eventId)} a rv:ClassificationDecisionChangedEvent ; rv:receipt ${iri(value.receipt)} }
      }`)).boolean).toBe(true);
    }
    expect((await fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(nativeSlot)} rv:decisionHead ${iri(converted[1]!.decision!.value)} .
        ${iri(sense)} rv:head ${iri(changedSenseHead)} .
        ${iri(converted[0]!.statement!.value)} rv:interpretationDefinition ${iri(senseRevision)} }
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(restoredEpoch)} ; rv:sequence 0 ; rv:restoreHold true .
        ${iri(marker)} rv:reconciledPriorSequence 2 }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(application)} ?p ?o } }
    }`)).boolean).toBe(true);
    expect(await facts(fuseki, [GRAPHS.revisions], [firstDecision])).toEqual(firstHistory);
    expect(await facts(fuseki, [GRAPHS.receipts], [decisions[0]!.receipt])).toEqual(firstReceipt);
    expect(await facts(fuseki, [GRAPHS.revisions], [senseRevision, changedSenseHead])).toEqual(retainedDefinitions);
    expect(await facts(fuseki, [GRAPHS.receipts], originalReceiptIds)).toEqual(originalReceipts);
    expect(await facts(fuseki, [GRAPHS.control], [MAIN_RELAY_STREAM_SCOPE])).toEqual(originalStream);
    expect(await relayCoverage(relayPool, consumer)).toEqual(coverage);
    expect((await accessPool.query('SELECT open FROM access.recovery_fence WHERE id')).rows).toEqual([{ open: false }]);
    const finished = await facts(fuseki, allGraphs);
    expect(await fuseki.command(interrupted!)).toMatchObject({ status: 'committed',
      position: { datasetId: DATASET, dataEpoch: restoredEpoch, sequence: '0' } });
    expect(await fuseki.command(lostAcknowledgment!)).toMatchObject({ status: 'committed',
      position: { datasetId: DATASET, dataEpoch: restoredEpoch, sequence: '0' } });
    expect(await fuseki.command({ ...lostAcknowledgment!, update: `${lostAcknowledgment!.update}\n# changed replay template` }))
      .toEqual({ status: 'conflict' });
    expect(await fuseki.command({ ...lostAcknowledgment!, digest: hash('changed retained request') }))
      .toEqual({ status: 'conflict' });
    for (const value of decisions) expect(await reconcile(value.sequence)).toEqual({
      receipt: value.receipt, application, decision: value.decision, replayed: true });
    expect(await facts(fuseki, allGraphs)).toEqual(finished);
    await assertRawUpdateClosed();
  } finally {
    await accessPool?.end();
    await relayPool?.end();
    if (env) rmSync(env.objectDirectory, { recursive: true, force: true });
    rootCommand(['stack:reset', ...stack.args], 120_000);
  }
}, 360_000);
