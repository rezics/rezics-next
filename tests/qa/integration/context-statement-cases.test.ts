import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { classificationDecisionSlotIri, classificationDecisionDigest, classificationDecisionReceiptIri,
  readClassificationDecisionReceipt, CLASSIFICATION_DIRECT_DECISION_PROFILE }
  from '../../../services/main/src/modules/classification/decision.ts';
import { classificationPropositionDigest, createClassificationProposition }
  from '../../../services/main/src/modules/classification/proposition.ts';
import { convertPopulatedStatements } from '../../../services/main/src/modules/statement/populated-conversion.ts';
import { resolveClassification, ClassificationResolutionUnavailable } from '../../../services/main/src/modules/classification/resolve.ts';
import { StatementSeek } from '../../../services/main/src/modules/statement/seek.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { CATALOGUE_IMPORT_SCOPE, catalogueImportIdentity, prepareCatalogueImport }
  from '../../../services/main/src/modules/work/catalogue-import.ts';
import { readWorkTerminalReceipt } from '../../../services/main/src/modules/work/receipt.ts';
import { readStatement, resolveStatementAcceptancesAt } from '../../../services/main/src/modules/statement/read.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../../../services/main/src/modules/classification/context.ts';
import { GRAPHS, DATASET, CONTINUITY, prepareComponent, hash, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce, relayCoverage, readMainOutboxEnvelope, readNextMainOutboxBatch }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { reconcileRetainedWorkCreate, reconcileRetainedClassificationDecision } from '../../../services/main/src/modules/work/reconcile-restored.ts';
import { cutoverRestoredGraphLineage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { contextFixture, nativeId, RV } from './context-fixture.ts';
import { assertCommandRace } from '../support/command-race.ts';
import { migrateOwnerData, assertOwnerMigrationsComplete } from '../../../scripts/fixture/migrate.ts';
import { migrateTracked, migrationRecords, repositoryRoot, migrationDirectories } from '../../../scripts/ops/migrate.ts';
import { executeRefresh, refreshPlan, type RefreshInputs, type RefreshActions } from '../../../scripts/dev/refresh.ts';
import { statementUpgradeCurrent } from '../../../services/main/src/modules/statement/upgrade.ts';
import { commandReceiptIri, readCommandReceipt } from '../../../services/main/src/modules/context/command.ts';

type ContextWrite = { context: string; semanticRevision: string; replayed: boolean };
type SelectionWrite = { selection: string; selectionRevision: string; replayed: boolean };
type StatementWrite = { statement: string; meaningKey: string; revision: string; replayed: boolean };
type DecisionWrite = { decision: string; slot: string; replayed: boolean;
  sourcePosition: { dataEpoch: string; sequence: string } };
type Resolution = { result: { state: string; source?: string; decision?: string } };

test('refresh alone converts populated catalogue decisions, resumes fenced failures and then is a no-op with seek reads',async () => {
  const f = await contextFixture(Bun.env as Record<string,string>);
  const graphs = [GRAPHS.current,GRAPHS.revisions,GRAPHS.receipts,GRAPHS.outbox,GRAPHS.control];
  const prefix = `urn:rezics:test-copy:${randomUUID()}`;
  for (const [index,graph] of graphs.entries())
    await f.env.fuseki.update(`ADD SILENT GRAPH ${iri(graph)} TO GRAPH ${iri(`${prefix}:${index}`)}`);
  try {
    await f.globalAcceptance();
    const input = {label: 'Refresh retained definition',actingSubject: f.actorA};
    const term = await createClassificationProposition(f.env,f.admission('classification:define:global',
      'classification.proposition.define',classificationPropositionDigest(input)),input);
    const work = await f.work('Refresh legacy catalogue');
    const application = nativeId(),head = nativeId(),operation = nativeId();
    const slot = classificationDecisionSlotIri(work.mainVersion!,term.definitions!.sense,GLOBAL_CLASSIFICATION_CONTEXT);
    const manifest = prepareComponent(f.env.objectDirectory,application,{work: work.work,mainVersion: work.mainVersion,
      sense: term.definitions!.sense,senseRevision: term.revision,context: GLOBAL_CLASSIFICATION_CONTEXT,
      proposer: f.actorA,decider: f.actorB,outcome: 'accepted',application,decision: head,slot,
      policy: CLASSIFICATION_DIRECT_DECISION_PROFILE},CLASSIFICATION_DIRECT_DECISION_PROFILE);
    // Retained data predates migration 1300. No operator conversion or fence
    // command is called; refresh's real owner-preparation pipeline owns both.
    await f.accessPool.query('DROP TABLE access.statement_seek,access.statement_seek_coverage');
    // QA installs owner DDL directly. Reconstruct the pre-upgrade Access
    // tracker so refresh exercises the same locked migration runner as dev.
    await f.accessPool.query(`CREATE TABLE IF NOT EXISTS public.rezics_local_migration
      (name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
    await f.accessPool.query(`INSERT INTO public.rezics_local_migration(name)
      SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`,
    [migrationRecords(repositoryRoot,'access').filter(value => value.version !== 1300).map(value => value.name)]);
    await f.accessPool.query("DELETE FROM public.rezics_local_migration WHERE name LIKE '%1300%'");
    const missing = `urn:rezics:sha256:${'0'.repeat(64)}`;
    await f.env.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(application)} a rv:ClassificationApplication ;
        rv:targetMainVersion ${iri(work.mainVersion!)} ; rv:sense ${iri(term.definitions!.sense)} ;
        rv:classificationContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:applicationChannel rv:Curated ;
        rv:applicationState rv:Active ; rv:proposer ${iri(f.actorA)} ; rv:decisionHead ${iri(head)} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} a rv:ClassificationDecision,rv:RevisionAnchor ;
        rv:component ${iri(application)} ; rv:manifest ${iri(missing)} ; rv:outcome rv:Accepted ;
        rv:decidedBy ${iri(f.actorB)} ; rv:operation ${iri(operation)} ;
        rv:dataEpoch ${lit(f.env.lineage.dataEpoch)} ; rv:sequence 1 }
    }`);
    await f.grant('work:create:root','work.create');
    await f.grant('classification:decide:global','classification.decision.set');
    const principal = await f.account.verifier.verify(new Request('http://main.local',{
      headers: {authorization: `Bearer ${f.account.tokenA}`}}),['work:create','classification:decide']);
    const pending = [];
    const legacyEvent = `urn:rezics:event:retained-cutover:${randomUUID()}`;
    let retainedPosition = '';
    for (const action of ['work.create','classification.decision.set','statement.migrate','statement.cutover']) {
      const scope = action === 'work.create' ? 'work:create:root' : 'classification:decide:global';
      const admission = await f.access.register({principal,actingSubject: f.actorA,scope,
        action: action.startsWith('statement.') ? 'classification.decision.set' : action,idempotencyKey: randomUUID(),requestDigest: hash(randomUUID())});
      if (action.startsWith('statement.')) await f.accessPool.query('UPDATE access.admission SET action=$2 WHERE id=$1',[admission.id,action]);
      pending.push(admission.id);
      if (action === 'statement.cutover') {
        const receipt = commandReceiptIri(admission.id,'statement-cutover-v1');
        retainedPosition = (await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence } }`)).results!.bindings[0]!.sequence!.value;
        // Reconstruct an already-terminal, undelivered legacy cancellation in
        // its original batch. Upgrade must preserve that receipt and Relay read.
        await f.env.fuseki.update(`PREFIX rv: <${RV}>
          DELETE { GRAPH ${iri(GRAPHS.outbox)} { ?batch rv:eventCount ?count } }
          INSERT { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
            rv:commandFamily "statement-cutover-v1" ; rv:requestDigest ${lit(admission.requestDigest)} ;
            rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
            rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ; rv:reason rv:Unavailable ;
            rv:dataEpoch ${lit(f.env.lineage.dataEpoch)} ; rv:sequence ${retainedPosition} }
          GRAPH ${iri(GRAPHS.outbox)} { ?batch rv:eventCount ?next ; rv:event ${iri(legacyEvent)} .
            ${iri(legacyEvent)} a rv:StatementCutoverCancelledEvent ; rv:ordinal ?count ;
              rv:action "statement.cutover" ; rv:receipt ${iri(receipt)} } }
          WHERE { GRAPH ${iri(GRAPHS.outbox)} { ?batch a rv:OutboxBatch ;
            rv:dataEpoch ${lit(f.env.lineage.dataEpoch)} ; rv:sequence ${retainedPosition} ; rv:eventCount ?count }
            BIND(?count+1 AS ?next) }`);
      }
    }
    const apps = {...Bun.env,MAIN_OBJECT_DIRECTORY: f.env.objectDirectory,MAIN_S3_ENDPOINT: ''} as Record<string,string>;
    const events: string[] = [];
    let stopped = false;
    const actions: RefreshActions = {
      buildImage: async () => {},rehearseMigrations: async () => {},
      stopWriters: async () => {stopped = true;events.push('stop-writers');},
      prepareStorage: async () => {
        expect(stopped).toBe(true);events.push('prepare-storage');
        await migrateTracked(apps.ACCESS_DATABASE_URL!,repositoryRoot,migrationDirectories.access);
        assertOwnerMigrationsComplete(await migrateOwnerData(apps));
      },alignModel: async () => {},
      restartResources: async () => {
        expect(await statementUpgradeCurrent(f.env.fuseki,f.env.lineage.dataEpoch,f.accessPool)).toBe(true);
        events.push('restart-resources');stopped = false;
      },waitReady: async () => {},approveZones: async () => {},stopAppHost: async () => {},
      recordSuccess: async () => {events.push('record-success');},
    };
    const current: RefreshInputs = {revision: 'current',previousRevision: 'current',imagePresent: true,
      storageChanged: false,pendingMigrations: [],modelCurrent: true,statementCurrent: false,
      unhealthyResources: [],environmentChanges: [],appHostChanged: false,lostResources: [],zoneApprovals: []};
    await expect(executeRefresh(refreshPlan(current),actions)).rejects.toThrow();
    expect(events).toEqual(['stop-writers','prepare-storage']);
    expect((await f.accessPool.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(false);
    expect((await new StatementSeek(f.accessPool,f.env).coverage())?.complete).toBe(false);
    expect((await f.env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:restoreHold true } }`)).boolean).toBe(true);
    expect((await f.accessPool.query('SELECT state,graph_outcome FROM access.admission WHERE id=ANY($1::uuid[])',[pending])).rows)
      .toEqual(pending.map(() => ({state: 'sealed',graph_outcome: 'cancelled'})));
    await f.env.fuseki.update(`DELETE DATA { GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} <${RV}manifest> ${iri(missing)} } };
      INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} <${RV}manifest> ${iri(`urn:rezics:sha256:${manifest}`)} } }`);
    events.length = 0;
    await executeRefresh(refreshPlan(current),actions);
    expect(events).toEqual(['stop-writers','prepare-storage','restart-resources','record-success']);
    const coverage = await new StatementSeek(f.accessPool,f.env).coverage();
    const references = await new StatementSeek(f.accessPool,f.env).seek(
      {dataEpoch: f.env.lineage.dataEpoch,sequence: coverage!.through_sequence},work.mainVersion!,null);
    expect(references.candidates).toHaveLength(1);
    const statement = references.candidates[0]!.statementId;
    expect((await readStatement(f.env,statement,async () => false)).export['http://www.w3.org/ns/prov#wasAttributedTo'])
      .toEqual([{'@id': f.actorA}]);
    await f.json(await f.call('GET',`/v1/statements/${statement.slice(-36)}`),200);
    const qualified = {kind: 'qualified-fact' as const,meaningKey: references.candidates[0]!.meaningKey};
    expect((await resolveStatementAcceptancesAt(f.env,[qualified],{kind: 'global'},
      {dataEpoch: f.env.lineage.dataEpoch,sequence: coverage!.through_sequence})).get(qualified.meaningKey)?.result)
      .toMatchObject({state: 'accepted'});
    const batch = await readNextMainOutboxBatch(f.env.fuseki,f.env.lineage.dataEpoch,String(BigInt(retainedPosition)-1n));
    expect(batch).not.toBeNull();
    expect((await readMainOutboxEnvelope(f.env.fuseki,batch!,legacyEvent)).data.receipt)
      .toMatchObject({action: 'statement.cutover',outcome: 'cancelled',admissionId: pending.at(-1)});
    expect((await readCommandReceipt(f.env,pending.at(-1)!,'statement-cutover-v1'))?.sequence).toBe(retainedPosition);
    const receipts = (await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:convertedApplication ${iri(application)} } }`)).results!.bindings;
    expect(receipts).toHaveLength(1);
    events.length = 0;
    await executeRefresh(refreshPlan({...current,statementCurrent: await statementUpgradeCurrent(
      f.env.fuseki,f.env.lineage.dataEpoch,f.accessPool)}),actions);
    expect(events).toEqual([]);
    expect((await migrateOwnerData(apps)).find(value => value.owner === 'catalogue-statements'))
      .toMatchObject({status: 'complete',converted: 0,replayed: 0,noop: true});
    expect(await new StatementSeek(f.accessPool,f.env).coverage()).toEqual(coverage);
  } finally {
    await migrateTracked(Bun.env.ACCESS_DATABASE_URL!,repositoryRoot,migrationDirectories.access);
    await f.accessPool.query('UPDATE access.recovery_fence SET open=true WHERE id');
    for (const [index,graph] of graphs.entries()) {
      await f.env.fuseki.update(`CLEAR SILENT GRAPH ${iri(graph)};
        ADD SILENT GRAPH ${iri(`${prefix}:${index}`)} TO GRAPH ${iri(graph)}`);
      await f.env.fuseki.update(`DROP SILENT GRAPH ${iri(`${prefix}:${index}`)}`);
    }
    await new StatementSeek(f.accessPool,f.env).rebuild();
    await f.close();
  }
},180_000);

test('CTX09: catalogue imports use exact definitions, replay and CAS; populated conversion retains provenance and rebuilds seek', async () => {
  const f = await contextFixture(Bun.env as Record<string,string>);
  const relay = new Pool({connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL});
  const copies: string[] = [];
  const graphs = [GRAPHS.current,GRAPHS.revisions,GRAPHS.receipts,GRAPHS.outbox,GRAPHS.control];
  const snapshot = async () => {
    const prefix = `urn:rezics:test-copy:${randomUUID()}`;
    for (const [index,graph] of graphs.entries()) {
      const copy = `${prefix}:${index}`;copies.push(copy);
      await f.env.fuseki.update(`COPY GRAPH ${iri(graph)} TO GRAPH ${iri(copy)}`);
    }
    return async () => {
      for (const [index,graph] of graphs.entries())
        await f.env.fuseki.update(`COPY GRAPH ${iri(`${prefix}:${index}`)} TO GRAPH ${iri(graph)}`);
    };
  };
  let restoreLive: (() => Promise<void>)|null = null;
  try {
    await f.globalAcceptance();
    await f.grant(CATALOGUE_IMPORT_SCOPE,'work.create');
    await f.grant('classification:decide:global','classification.decision.set');
    const platformGrant = randomUUID();
    await f.accessPool.query(`INSERT INTO access.principal_permission_grant
      (id,issuer_subject,principal_id,scope_id,action,valid_until)
      VALUES ($1,$2,$3,'platform:access','platform:use:catalogue-import',now()+interval '1 hour')`,
    [platformGrant,f.actorA,f.principalA]);
    await f.accessPool.query(`INSERT INTO access.platform_grant_episode
      (id,principal_grant_id,issuer_subject,permission,scope_id,assigned_by_principal,receipt)
      VALUES ($1,$2,$3,'platform:use:catalogue-import','platform:access',$4,$5)`,
    [randomUUID(),platformGrant,f.actorA,f.principalA,`urn:rezics:access-receipt:${hash(platformGrant)}`]);
    const principal = await f.account.verifier.verify(new Request('http://main.local',{
      headers: {authorization: `Bearer ${f.account.tokenA}`}}),['work:create']);
    expect((await new AccessExposure(f.accessPool).summary(principal)).groups).toContain('catalogue-import');
    const propositionInput = {label: 'Exact catalogue definition',actingSubject: f.actorA};
    const proposition = await createClassificationProposition(f.env,f.admission('classification:define:global',
      'classification.proposition.define',classificationPropositionDigest(propositionInput)),propositionInput);
    const concept = proposition.definitions!.concept,definition = proposition.revision!;
    const backupSequence = (await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence } }`)).results!.bindings[0]!.sequence!.value;
    const restoreBackup = await snapshot();
    const input = {profile: 'work-catalogue-import-v1',expectedWorkHead: null,title: 'Statement catalogue',language: 'en',
      evidence: 'Catalogue source evidence',aliases: [],semanticTypes: [],credits: [],
      classifications: [{concept,definition,expectedDecisionHead: null,outcome: 'accepted'}]};
    const key = randomUUID();
    const imported = await f.json<{status: string;receipt: {work: string;mainVersion: string;sequence: string}}>(
      await f.call('POST','/v1/work-imports',{actingSubject: f.actorA,input},key),201);
    expect(imported.status).toBe('succeeded');
    expect((await f.json<{replayed: boolean}>(await f.call('POST','/v1/work-imports',
      {actingSubject: f.actorA,input},key),200)).replayed).toBe(true);
    expect((await f.call('POST','/v1/work-imports',{actingSubject: f.actorA,input: {...input,title: 'Changed'}},key)).status).toBe(409);
    const stale = await f.json<{code: string}>(await f.call('POST','/v1/work-imports',
      {actingSubject: f.actorA,input: {...input,work: imported.receipt.work}},randomUUID()),409);
    expect(stale.code).toBe('catalogue_import_conflict');
    const rows = (await f.env.fuseki.query(`PREFIX rv: <${RV}> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      SELECT ?statement ?decision ?slot ?key WHERE { GRAPH ${iri(GRAPHS.current)} {
        ?statement a rdf:Statement ; rdf:subject ${iri(imported.receipt.mainVersion)} ; rdf:object ${iri(concept)} ;
          rv:interpretationDefinition ${iri(definition)} ; rv:meaningKey ?key .
        ?slot a rv:DecisionSlot ; rv:decisionTarget ?key ; rv:decisionHead ?decision }
      GRAPH ${iri(GRAPHS.revisions)} { ?decision a rv:StatementDecision ; rv:support ?statement } }`)).results!.bindings;
    expect(rows).toHaveLength(1);
    const position = {dataEpoch: f.env.lineage.dataEpoch,sequence: (await f.env.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?sequence WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence } }`)).results!.bindings[0]!.sequence!.value};
    const qualified = {kind: 'qualified-fact' as const,meaningKey: rows[0]!.key!.value};
    expect((await resolveStatementAcceptancesAt(f.env,[qualified],{kind: 'global'},position))
      .get(qualified.meaningKey)!.result).toMatchObject({state: 'accepted',decision: rows[0]!.decision!.value});
    const slotRef = rows[0]!.slot!.value;
    await f.env.fuseki.update(`DELETE DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(slotRef)} <${RV}targetKind> <${RV}QualifiedFactTarget> } }`);
    try {
      expect((await resolveStatementAcceptancesAt(f.env,[qualified],{kind: 'global'},position))
        .get(qualified.meaningKey)!.result).toEqual({state: 'unavailable'});
      await expect(resolveClassification(f.env,{work: imported.receipt.work,mainVersion: imported.receipt.mainVersion,
        sense: proposition.definitions!.sense,context: {kind: 'global'}}))
        .rejects.toBeInstanceOf(ClassificationResolutionUnavailable);
    } finally {await f.env.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(slotRef)} <${RV}targetKind> <${RV}QualifiedFactTarget> } }`);}
    expect((await f.env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
      ?application a rv:ClassificationApplication ; rv:targetMainVersion ${iri(imported.receipt.mainVersion)} } }`)).boolean).toBe(false);
    expect((await f.call('POST','/v1/classification-decisions',{profile: 'classification-direct-decision-v1',
      context: {kind: 'global'},work: imported.receipt.work,mainVersion: imported.receipt.mainVersion,
      sense: proposition.definitions!.sense,expectedDecisionHead: null,outcome: 'accepted',actingSubject: f.actorA})).status).toBe(404);
    expect((await f.call('GET','/v1/statement-migrations/v1/pending')).status).toBe(404);

    // An isolated populated copy includes two immutable legacy revisions.
    // Only this fixture reconstructs old storage; no live legacy writer remains.
    const oldWork = await f.work('Retained catalogue copy');
    const application = nativeId(),first = nativeId(),head = nativeId(),operation = nativeId();
    const slot = classificationDecisionSlotIri(oldWork.mainVersion!,proposition.definitions!.sense,GLOBAL_CLASSIFICATION_CONTEXT);
    const manifest = prepareComponent(f.env.objectDirectory,application,{work: oldWork.work,mainVersion: oldWork.mainVersion,
      sense: proposition.definitions!.sense,senseRevision: definition,context: GLOBAL_CLASSIFICATION_CONTEXT,
      proposer: f.actorA,decider: f.actorB,outcome: 'rejected',application,decision: head,slot,predecessor: first,
      policy: 'https://rezics.com/definition/classification-direct-decision-v1'},
    'https://rezics.com/definition/classification-direct-decision-v1');
    const digest = hash(application),receipt = 'urn:rezics:receipt:bootstrap:populated-copy:'+digest;
    await f.env.fuseki.update(`PREFIX rv: <${RV}>
      INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(application)} a rv:ClassificationApplication ;
        rv:targetMainVersion ${iri(oldWork.mainVersion!)} ; rv:sense ${iri(proposition.definitions!.sense)} ;
        rv:classificationContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:applicationChannel rv:Curated ;
        rv:applicationState rv:Active ; rv:proposer ${iri(f.actorA)} ; rv:decisionHead ${iri(head)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(first)} a rv:ClassificationDecision,rv:RevisionAnchor ; rv:component ${iri(application)} ; rv:outcome rv:Accepted .
        ${iri(head)} a rv:ClassificationDecision,rv:RevisionAnchor ; rv:component ${iri(application)} ; rv:predecessor ${iri(first)} ;
          rv:manifest ${iri('urn:rezics:sha256:'+manifest)} ; rv:outcome rv:Rejected ; rv:decidedBy ${iri(f.actorB)} ;
          rv:operation ${iri(operation)} ; rv:dataEpoch ${lit(f.env.lineage.dataEpoch)} ; rv:sequence 1 . }
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
        rv:dataEpoch ${lit(f.env.lineage.dataEpoch)} ; rv:sequence ?sequence . }
      } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence } }`);
    await f.accessPool.query('UPDATE access.recovery_fence SET open=false WHERE id=true');
    const converted = await convertPopulatedStatements(f.env,f.accessPool);
    expect(converted).toEqual({converted: 1,replayed: 0});
    expect(await convertPopulatedStatements(f.env,f.accessPool)).toEqual({converted: 0,replayed: 1});
    const retained = await f.env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} rv:predecessor ${iri(first)} ; rv:operation ${iri(operation)} .
        ${iri(first)} a rv:ClassificationDecision .
        ?decision a rv:StatementDecision ; rv:convertedFrom ${iri(head)} ; rv:decidedBy ${iri(f.actorB)} . }
      GRAPH ${iri(GRAPHS.current)} { ?statement rv:migratedFrom ${iri(application)} ; rv:speaker ${iri(f.actorA)} } }`);
    expect(retained.boolean).toBe(true);
    const seek = new StatementSeek(f.accessPool,f.env);
    expect((await seek.coverage())?.complete).toBe(true);
    const restored = (await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?statement WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?statement rv:migratedFrom ${iri(application)} } }`)).results!.bindings[0]!.statement!.value;
    // Release only this isolated copy's fences, then verify public attribution.
    const releaseDigest = hash(receipt+'release');
    await f.env.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        INSERT { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt+':release')} rv:requestDigest ${lit(releaseDigest)} ;
          rv:dataEpoch ${lit(f.env.lineage.dataEpoch)} ; rv:sequence ?sequence } }
        WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence } }`);
    await f.accessPool.query('UPDATE access.recovery_fence SET open=true WHERE id=true');
    const exported = await readStatement(f.env,restored,async () => false);
    expect(exported.export['http://www.w3.org/ns/prov#wasAttributedTo']).toEqual([{'@id': f.actorA}]);
    expect(JSON.stringify(exported.export)).toContain(f.actorB);

    // Restore the populated graph backup made before this import, while retaining
    // the real Access seal, Relay envelope and immutable manifests.
    const consumer = `catalogue-restore:${randomUUID()}`;
    await initializeRelayCheckpoint(relay,consumer,f.env.lineage.dataEpoch);
    while (await relayMainOutboxOnce(f.env.fuseki,relay,consumer)) { /* retain the bounded batches */ }
    const coverage = await relayCoverage(relay,consumer);
    restoreLive = await snapshot();
    await f.accessPool.query('UPDATE access.recovery_fence SET open=false WHERE id=true');
    await restoreBackup();
    const next = {dataEpoch: randomUUID(),routingEpoch: /^\d+$/u.test(f.env.lineage.routingEpoch)
      ? String(BigInt(f.env.lineage.routingEpoch)+1n) : randomUUID()};
    await cutoverRestoredGraphLineage(f.env.fuseki,{prior: {...f.env.lineage,sequence: backupSequence},next});
    const recovery = {...f.env,lineage: next};
    const recovered = await reconcileRetainedWorkCreate(recovery,f.accessPool,relay,coverage,imported.receipt.sequence);
    expect(recovered).toMatchObject({work: imported.receipt.work,replayed: false});
    expect(await reconcileRetainedWorkCreate(recovery,f.accessPool,relay,coverage,imported.receipt.sequence))
      .toMatchObject({work: imported.receipt.work,replayed: true});
    expect((await f.env.fuseki.query(`PREFIX rv: <${RV}> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      ASK { GRAPH ${iri(GRAPHS.current)} { ${iri(rows[0]!.statement!.value)} a rdf:Statement ;
        rdf:subject ${iri(imported.receipt.mainVersion)} ; rv:interpretationDefinition ${iri(definition)} .
        ?slot a rv:DecisionSlot ; rv:decisionHead ${iri(rows[0]!.decision!.value)} }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?application a rv:ClassificationApplication ;
          rv:targetMainVersion ${iri(imported.receipt.mainVersion)} } } }`)).boolean).toBe(true);
    await new StatementSeek(f.accessPool,recovery).rebuild();
    expect((await new StatementSeek(f.accessPool,recovery).coverage())?.complete).toBe(true);
  } finally {
    await restoreLive?.();
    await f.accessPool.query('UPDATE access.recovery_fence SET open=true WHERE id=true');
    await f.env.fuseki.update(`DELETE WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} <${RV}restoreHold> ?hold } }`);
    for (const copy of copies) await f.env.fuseki.update(`DROP SILENT GRAPH ${iri(copy)}`);
    await relay.end();
    await f.close();
  }
},180_000);

test('retained catalogue restore converts the exact legacy input and preserves its sealed manifest',async () => {
  const f = await contextFixture(Bun.env as Record<string,string>);
  const relay = new Pool({connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL});
  const graphs = [GRAPHS.current,GRAPHS.revisions,GRAPHS.receipts,GRAPHS.outbox,GRAPHS.control];
  const copies: string[] = [];
  let restoreLive: (()=>Promise<void>)|null = null;
  const snapshot = async () => {
    const prefix = `urn:rezics:test-copy:${randomUUID()}`;
    for (const [index,graph] of graphs.entries()) {
      const copy = `${prefix}:${index}`;copies.push(copy);
      await f.env.fuseki.update(`COPY GRAPH ${iri(graph)} TO GRAPH ${iri(copy)}`);
    }
    return async () => {for (const [index,graph] of graphs.entries())
      await f.env.fuseki.update(`COPY GRAPH ${iri(`${prefix}:${index}`)} TO GRAPH ${iri(graph)}`);};
  };
  try {
    await f.globalAcceptance();
    await f.grant(CATALOGUE_IMPORT_SCOPE,'work.create');
    await f.grant('classification:decide:global','classification.decision.set');
    const propositionInput = {label: 'Retained catalogue definition',actingSubject: f.actorA};
    const term = await createClassificationProposition(f.env,f.admission('classification:define:global',
      'classification.proposition.define',classificationPropositionDigest(propositionInput)),propositionInput);
    const original = {profile: 'work-catalogue-import-v1' as const,expectedWorkHead: null,title: 'Retained catalogue',
      language: 'en',evidence: 'Retained source evidence',aliases: [],semanticTypes: [],credits: [],
      classifications: [{sense: term.definitions!.sense,expectedSenseHead: term.revision!,
        expectedDecisionHead: null,outcome: 'accepted' as const}]};
    const requestDigest = hash(JSON.stringify({family: 'work-catalogue-import-v1',actingSubject: f.actorA,input: original}));
    const principal = await f.account.verifier.verify(new Request('http://main.local',{
      headers: {authorization: `Bearer ${f.account.tokenA}`}}),['work:create','classification:decide']);
    const [registered] = await f.access.admitCatalogue(principal,f.actorA,[{key: randomUUID(),digest: requestDigest}]);
    if (!registered || 'status' in registered) throw new Error('Retained catalogue fixture admission was denied');
    const admission = registered.admission;
    const work = catalogueImportIdentity(admission.id,'work'),main = catalogueImportIdentity(admission.id,'main');
    const base = {...original,classifications: []};
    const envelope = await prepareCatalogueImport(f.env,admission,base,[],new Map());
    const baseManifest = prepareComponent(f.env.objectDirectory,work,{mainVersion: main,continuityProfile: CONTINUITY,
      ...base,creditHeads: {}});
    const oldManifest = prepareComponent(f.env.objectDirectory,work,{mainVersion: main,continuityProfile: CONTINUITY,...original});
    expect(envelope.update).toContain(`urn:rezics:sha256:${baseManifest}`);
    envelope.update = envelope.update.replaceAll(`urn:rezics:sha256:${baseManifest}`,`urn:rezics:sha256:${oldManifest}`);
    const backupSequence = (await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence } }`)).results!.bindings[0]!.sequence!.value;
    const restoreBackup = await snapshot();
    // Only this isolated fixture encodes the historical input. It is backed by
    // a real admitted graph commit, Access seal, immutable manifest and Relay.
    await f.env.fuseki.catalogueBatch([envelope]);
    const receipt = (await readWorkTerminalReceipt(f.env.fuseki,admission.id))!;
    expect(receipt.outcome).toBe('succeeded');
    await f.access.recordCatalogueOutcomes([receipt]);
    // Emulate a subsequent sealed decision from the retained release, including
    // its immutable predecessor, rather than invoke the retired writer.
    const predecessor = catalogueImportIdentity(admission.id,'decision:0');
    const application = catalogueImportIdentity(admission.id,'application:0');
    const slot = classificationDecisionSlotIri(main,term.definitions!.sense,GLOBAL_CLASSIFICATION_CONTEXT);
    const followingInput = {context: {kind: 'global' as const},work,mainVersion: main,sense: term.definitions!.sense,
      expectedDecisionHead: predecessor,outcome: 'rejected' as const,actingSubject: f.actorA};
    const followingDigest = classificationDecisionDigest(followingInput);
    const following = await f.access.register({principal,actingSubject: f.actorA,scope: 'classification:decide:global',
      action: 'classification.decision.set',idempotencyKey: randomUUID(),requestDigest: followingDigest});
    await f.access.claim(following.id,followingDigest);
    const operation = nativeId(),decision = nativeId(),followingReceipt = classificationDecisionReceiptIri(following.id);
    const sequence = String(BigInt(receipt.sequence)+1n),event = 'urn:rezics:event:'+hash(operation);
    const batch = 'urn:rezics:outbox:'+hash(followingReceipt);
    const manifest = 'urn:rezics:sha256:'+prepareComponent(f.env.objectDirectory,application,{work,mainVersion: main,
      sense: term.definitions!.sense,senseRevision: term.revision!,context: GLOBAL_CLASSIFICATION_CONTEXT,
      realm: null,contextRevision: null,proposer: f.actorA,decider: f.actorA,outcome: 'rejected',
      application,decision,slot,predecessor,policy: CLASSIFICATION_DIRECT_DECISION_PROFILE},CLASSIFICATION_DIRECT_DECISION_PROFILE);
    await f.env.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:sequence ?oldSequence . ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence ?oldStreamSequence } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ${sequence} .
        ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence ?nextStreamSequence }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} a rv:ClassificationDecision,rv:RevisionAnchor ;
          rv:component ${iri(application)} ; rv:application ${iri(application)} ; rv:operation ${iri(operation)} ;
          rv:manifest ${iri(manifest)} ; rv:outcome rv:Rejected ; rv:decisionBasis rv:GlobalCuratorReview ;
          rv:decidedBy ${iri(f.actorA)} ; rv:decisionPolicy ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
          rv:modelRevision ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ; rv:shapeRevision ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
          rv:predecessor ${iri(predecessor)} ; rv:dataEpoch ${lit(f.env.lineage.dataEpoch)} ; rv:sequence ${sequence} }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(followingReceipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
          rv:admissionId ${lit(following.id)} ; rv:requestDigest ${lit(followingDigest)} ; rv:authorityEpoch ${lit(following.authorityEpoch)} ;
          rv:admittedScope "classification:decide:global" ; rv:operation ${iri(operation)} ; rv:work ${iri(work)} ;
          rv:mainVersion ${iri(main)} ; rv:sense ${iri(term.definitions!.sense)} ; rv:classificationContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
          rv:slot ${iri(slot)} ; rv:application ${iri(application)} ; rv:decision ${iri(decision)} ; rv:decisionOutcome rv:Rejected ;
          rv:expectedHead ${iri(predecessor)} ; rv:dataEpoch ${lit(f.env.lineage.dataEpoch)} ; rv:sequence ${sequence} }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(f.env.lineage.dataEpoch)} ;
          rv:streamScope ${lit(MAIN_RELAY_STREAM_SCOPE)} ; rv:streamSequence ?nextStreamSequence ;
          rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:ClassificationDecisionChangedEvent ; rv:ordinal 0 ; rv:action "classification.decision.set" ;
          rv:receipt ${iri(followingReceipt)} ; rv:operation ${iri(operation)} ; rv:work ${iri(work)} ; rv:application ${iri(application)} }
      } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?oldSequence }
        GRAPH ${iri(GRAPHS.control)} { ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence ?oldStreamSequence }
        BIND(?oldStreamSequence+1 AS ?nextStreamSequence)
        FILTER(STR(?oldSequence)=${lit(receipt.sequence)}) }`);
    const followingTerminal = (await readClassificationDecisionReceipt(f.env,following.id))!;
    await f.access.recordGraphOutcome(following.id,followingTerminal);
    const consumer = `retained-catalogue:${randomUUID()}`;
    await initializeRelayCheckpoint(relay,consumer,f.env.lineage.dataEpoch);
    while (await relayMainOutboxOnce(f.env.fuseki,relay,consumer)) { /* retain real envelopes */ }
    const coverage = await relayCoverage(relay,consumer);
    restoreLive = await snapshot();
    await f.accessPool.query('UPDATE access.recovery_fence SET open=false WHERE id=true');
    await restoreBackup();
    const next = {dataEpoch: randomUUID(),routingEpoch: /^\d+$/u.test(f.env.lineage.routingEpoch)
      ? String(BigInt(f.env.lineage.routingEpoch)+1n) : randomUUID()};
    await cutoverRestoredGraphLineage(f.env.fuseki,{prior: {...f.env.lineage,sequence: backupSequence},next});
    const recovery = {...f.env,lineage: next};
    expect(await reconcileRetainedWorkCreate(recovery,f.accessPool,relay,coverage,receipt.sequence))
      .toMatchObject({work,replayed: false});
    expect(await reconcileRetainedWorkCreate(recovery,f.accessPool,relay,coverage,receipt.sequence))
      .toMatchObject({work,replayed: true});
    expect(await reconcileRetainedClassificationDecision(recovery,f.accessPool,relay,coverage,sequence))
      .toMatchObject({replayed: false});
    expect(await reconcileRetainedClassificationDecision(recovery,f.accessPool,relay,coverage,sequence))
      .toMatchObject({replayed: true});
    expect((await f.env.fuseki.query(`PREFIX rv: <${RV}> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      ASK { GRAPH ${iri(GRAPHS.current)} { ?statement a rdf:Statement ; rdf:subject ${iri(main)} ;
        rdf:object ${iri(term.definitions!.concept)} ; rv:interpretationDefinition ${iri(term.revision!)} . }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(receipt.workRevision!)} rv:manifest ${iri('urn:rezics:sha256:'+oldManifest)} .
          ${iri(decision)} rv:predecessor ${iri(predecessor)} ; rv:manifest ${iri(manifest)} .
          ?decision a rv:StatementDecision ; rv:convertedFrom ${iri(decision)} ; rv:outcome rv:Rejected ;
            rv:predecessor ?priorNative . ?priorNative rv:convertedFrom ${iri(predecessor)} }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?application a rv:ClassificationApplication ;
          rv:targetMainVersion ${iri(main)} } } }`)).boolean).toBe(true);
  } finally {
    await restoreLive?.();
    await f.accessPool.query('UPDATE access.recovery_fence SET open=true WHERE id=true');
    await f.env.fuseki.update(`DELETE WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} <${RV}restoreHold> ?hold } }`);
    for (const copy of copies) await f.env.fuseki.update(`DROP SILENT GRAPH ${iri(copy)}`);
    await relay.end();await f.close();
  }
},120_000);

test('CTX01/MODEL13: shared Context selection preserves distinct Realm and personal Statement meanings', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const object = nativeId();
    const definitionA = nativeId();
    const definitionB = nativeId();
    const relation = `${RV}classifiedAs`;
    const entry = (definition: string) => ({ target: object, relation,
      state: 'defined', definition, applicability: [] });
    await f.grant('context:create:root', 'context.create');
    const create = (definition: string) => f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
      entries: [entry(definition)], actingSubject: f.actorA });
    const createdA = await create(definitionA);
    if (createdA.status !== 201) console.error('shared Context A', createdA.status, await createdA.clone().text());
    const sharedA = await f.json<ContextWrite>(createdA, 201);
    const createdB = await create(definitionB);
    if (createdB.status !== 201) console.error('shared Context B', createdB.status, await createdB.clone().text());
    const sharedB = await f.json<ContextWrite>(createdB, 201);
    const realmA = await f.realm('Context A');
    const realmB = await f.realm('Context B');
    const selectionBody = (context: ContextWrite, expectedHead: string | null) => ({
      profile: 'context-selection-v1', scope: { kind: 'object', object },
      selection: { context: context.context, semanticRevision: context.semanticRevision },
      expectedHead, actingSubject: f.actorA });
    const realmBPath = `/v1/realms/${realmB.realm.split('/').at(-1)}/context-selections`;
    await f.revoke(await f.grant(`context:select:${realmB.realm}`, 'context.select'));
    expect((await f.call('POST', realmBPath, selectionBody(sharedA, null))).status).toBe(403);
    await f.grant(`context:select:${realmA.realm}`, 'context.select');
    const realmBGrant = await f.grant(`context:select:${realmB.realm}`, 'context.select');
    const select = async (realm: string, context: ContextWrite) => {
      const path = `/v1/realms/${realm.split('/').at(-1)}/context-selections`;
      const body = selectionBody(context, null);
      const key = randomUUID();
      const response = await f.call('POST', path, body, key);
      if (response.status !== 201) console.error('realm selection', response.status, await response.clone().text());
      const result = await f.json<SelectionWrite>(response, 201);
      expect(await f.json<SelectionWrite>(await f.call('POST', path, body, key), 200))
        .toMatchObject({ selection: result.selection, selectionRevision: result.selectionRevision,
          replayed: true });
      return result;
    };
    const adoptionA = await select(realmA.realm, sharedA);
    const adoptionB = await select(realmB.realm, sharedA);
    expect(adoptionA.selection).not.toBe(adoptionB.selection);
    expect(adoptionA.selectionRevision).not.toBe(adoptionB.selectionRevision);
    const changedB = await f.json<SelectionWrite>(await f.call('POST',
      `/v1/realms/${realmB.realm.split('/').at(-1)}/context-selections`, {
        profile: 'context-selection-v1', scope: { kind: 'object', object },
        selection: { context: sharedB.context, semanticRevision: sharedB.semanticRevision },
        expectedHead: adoptionB.selectionRevision, actingSubject: f.actorA }), 201);
    expect(changedB.selection).toBe(adoptionB.selection);
    const raceCommands = [
      f.call.bind(
        f,
        'POST',
        realmBPath,
        selectionBody(sharedA, changedB.selectionRevision),
        randomUUID(),
      ),
      f.call.bind(
        f,
        'POST',
        realmBPath,
        { ...selectionBody(sharedA, changedB.selectionRevision), selection: null },
        randomUUID(),
      ),
    ];
    await assertCommandRace(await Promise.all(raceCommands.map((send) => send())), 201, (index) =>
      raceCommands[index]!(),
    );
    await f.revoke(realmBGrant);
    expect((await f.call('POST', realmBPath,
      selectionBody(sharedB, changedB.selectionRevision))).status).toBe(403);

    const privateFirst = await f.json<{ revision: string }>(await f.call('PUT', '/v1/me/context-selections', {
      profile: 'context-private-selection-v1', scope: { kind: 'object', object },
      selection: { context: sharedA.context, semanticRevision: sharedA.semanticRevision },
      expectedRevision: null }), 201);
    const privateSelectionResponse = await f.call('PUT', '/v1/me/context-selections', {
        profile: 'context-private-selection-v1', scope: { kind: 'object', object },
        selection: { context: sharedB.context, semanticRevision: sharedB.semanticRevision },
        expectedRevision: privateFirst.revision });
    if (privateSelectionResponse.status !== 201) console.error('personal selection', privateSelectionResponse.status,
      await privateSelectionResponse.clone().text());
    const privateSelection = await f.json<{ context: string; semanticRevision: string; state: string }>(
      privateSelectionResponse, 201);
    expect(privateSelection).toMatchObject({ context: sharedB.context,
      semanticRevision: sharedB.semanticRevision, state: 'selected' });
    expect((await f.call('GET', `/v1/me/context-selections?kind=object&object=${encodeURIComponent(object)}`,
      undefined, randomUUID(), f.account.tokenB)).status).toBe(404);
    const work = await f.work('Statement subject');
    if (!work.mainVersion) throw new Error('Work fixture failed');
    const subject = work.mainVersion;
    const relationDefinition = nativeId();
    const statementBody = (speaker: { kind: 'personal' } | { kind: 'realm'; realm: string }) => ({
      profile: 'statement-v1', speaker, subject, predicate: relation,
      relationDefinition, value: { kind: 'resource', iri: object },
      applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: f.actorA });
    await f.grant(`statement:speak:${realmA.realm}`, 'statement.record');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    const realmStatement = await f.json<StatementWrite>(await f.call('POST', '/v1/statements',
      statementBody({ kind: 'realm', realm: realmA.realm })), 201);
    const personalStatement = await f.json<StatementWrite>(await f.call('POST', '/v1/statements',
      statementBody({ kind: 'personal' })), 201);
    const realmRead = await f.json<{ speaker: string; meaningBasis: { state: string;
      interpretationDefinitions?: string[] }; export: Record<string, unknown> }>(await f.call('GET',
      `/v1/statements/${realmStatement.statement.split('/').at(-1)}`), 200);
    const personalRead = await f.json<typeof realmRead>(await f.call('GET',
      `/v1/statements/${personalStatement.statement.split('/').at(-1)}`), 200);
    expect(realmRead).toMatchObject({ speaker: realmA.realm,
      meaningBasis: { state: 'readable', interpretationDefinitions: [definitionA] } });
    expect(personalRead).toMatchObject({ speaker: f.actorA,
      meaningBasis: { state: 'readable', interpretationDefinitions: [definitionB] } });
    expect(realmStatement.meaningKey).not.toBe(personalStatement.meaningKey);
    expect(realmRead.export[`${RV}interpretationDefinition`]).toEqual([{ '@id': definitionA }]);
    // Identified rdf:Statement reification must not assert the unqualified base fact.
    const baseTriple = await f.env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(subject)} <${relation}> ${iri(object)} } }`);
    expect(baseTriple.boolean).toBe(false);
  } finally { await f.close(); }
}, 120_000);

test('CTX03: hidden Context basis and explicit unresolved selection never fall back', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const object = nativeId();
    const relation = `${RV}classifiedAs`;
    const privateDefinition = nativeId();
    await f.grant('context:create:root', 'context.create');
    const hidden = await f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'private', base: null,
      entries: [{ target: object, relation, state: 'defined', definition: privateDefinition, applicability: [] }],
      actingSubject: f.actorA }), 201);
    const hiddenPath = `/v1/contexts/${hidden.context.split('/').at(-1)}`;
    expect((await f.call('GET', hiddenPath, undefined, randomUUID(), null)).status).toBe(404);
    const readGrant = await f.grant(`context:read:${hidden.context}`, 'context.read');
    expect((await f.call('GET', `${hiddenPath}?actingSubject=${encodeURIComponent(f.actorA)}`)).status).toBe(200);
    const initialSelection = await f.json<{ revision: string }>(await f.call('PUT', '/v1/me/context-selections', {
      profile: 'context-private-selection-v1', scope: { kind: 'object', object },
      selection: { context: hidden.context, semanticRevision: hidden.semanticRevision },
      expectedRevision: null, actingSubject: f.actorA }), 201);
    const work = await f.work('Private meaning subject');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    const recorded = await f.json<StatementWrite>(await f.call('POST', '/v1/statements', {
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.mainVersion,
      predicate: relation, relationDefinition: nativeId(), value: { kind: 'resource', iri: object },
      applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: f.actorA }), 201);
    const statementPath = `/v1/statements/${recorded.statement.split('/').at(-1)}`;
    const anonymous = await f.json<{ meaningBasis: { state: string }; export: Record<string, unknown> }>(
      await f.call('GET', statementPath, undefined, randomUUID(), null), 200);
    expect(anonymous.meaningBasis).toEqual({ state: 'unavailable' });
    expect(JSON.stringify(anonymous)).not.toContain(privateDefinition);
    expect(JSON.stringify(anonymous)).not.toContain(hidden.semanticRevision);
    const authorized = await f.json<typeof anonymous>(await f.call('GET',
      `${statementPath}?actingSubject=${encodeURIComponent(f.actorA)}`), 200);
    expect(authorized.meaningBasis).toMatchObject({ state: 'readable',
      interpretationDefinitions: [privateDefinition] });
    f.faultNextStatementRead('missing-pin-context');
    const missingPin = await f.json<typeof anonymous>(await f.call('GET',
      `${statementPath}?actingSubject=${encodeURIComponent(f.actorA)}`), 200);
    expect(missingPin.meaningBasis).toEqual({ state: 'unavailable' });
    expect(JSON.stringify(missingPin)).not.toContain(privateDefinition);
    f.faultNextStatementRead('missing-head');
    expect((await f.call('GET', `${statementPath}?actingSubject=${encodeURIComponent(f.actorA)}`)).status)
      .toBe(503);
    await f.grant(`context:change:${hidden.context}`, 'context.change');
    const successorDefinition = nativeId();
    const successor = await f.json<ContextWrite>(await f.call('POST',
      `${hiddenPath}/semantic-revisions`, { profile: 'context-v1',
        expectedSemanticHead: hidden.semanticRevision, base: null,
        entries: [{ target: object, relation, state: 'defined', definition: successorDefinition,
          applicability: [] }], actingSubject: f.actorA }), 201);
    const oldRevision = await f.json<{ revision: string; semanticHead: string;
      entries: Array<{ definition: string }> }>(await f.call('GET',
        `${hiddenPath}?actingSubject=${encodeURIComponent(f.actorA)}&revision=${encodeURIComponent(hidden.semanticRevision)}`),
    200);
    expect(oldRevision).toMatchObject({ revision: hidden.semanticRevision,
      semanticHead: successor.semanticRevision,
      entries: [{ definition: privateDefinition }] });
    expect((await f.json<typeof oldRevision>(await f.call('GET',
      `${hiddenPath}?actingSubject=${encodeURIComponent(f.actorA)}`), 200)).entries)
      .toMatchObject([{ definition: successorDefinition }]);
    expect((await f.json<typeof anonymous>(await f.call('GET',
      `${statementPath}?actingSubject=${encodeURIComponent(f.actorA)}`), 200)).meaningBasis)
      .toMatchObject({ state: 'readable', interpretationDefinitions: [privateDefinition] });
    await f.revoke(readGrant);
    const revoked = await f.json<typeof anonymous>(await f.call('GET',
      `${statementPath}?actingSubject=${encodeURIComponent(f.actorA)}`), 200);
    expect(revoked.meaningBasis).toEqual({ state: 'unavailable' });
    expect(JSON.stringify(revoked.export)).not.toContain(privateDefinition);
    expect(JSON.stringify(revoked.export)).not.toContain(hidden.semanticRevision);

    const hiddenChild = await f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'private', base: hidden.semanticRevision,
      entries: [], actingSubject: f.actorA }), 201);
    const childReadGrant = await f.grant(`context:read:${hiddenChild.context}`, 'context.read');
    const childPath = `/v1/contexts/${hiddenChild.context.split('/').at(-1)}`;
    expect((await f.call('GET', childPath, undefined, randomUUID(), null)).status).toBe(404);
    await f.json(await f.call('PUT', '/v1/me/context-selections', {
      profile: 'context-private-selection-v1', scope: { kind: 'object', object },
      selection: { context: hiddenChild.context, semanticRevision: hiddenChild.semanticRevision },
      expectedRevision: initialSelection.revision, actingSubject: f.actorA }), 201);
    const hiddenBasePreview = await f.json<{ state: string }>(await f.call('POST',
      '/v1/context-interpretations', { profile: 'context-interpretation-v1',
        speaker: { kind: 'personal' }, object, relation, explicit: null,
        actingSubject: f.actorA }), 200);
    expect(hiddenBasePreview).toMatchObject({ state: 'unavailable' });
    expect(JSON.stringify(hiddenBasePreview)).not.toContain(privateDefinition);
    const restoredBaseGrant = await f.grant(`context:read:${hidden.context}`, 'context.read');
    const readableBase = await f.json<{ state: string; definition: string }>(await f.call('POST',
      '/v1/context-interpretations', { profile: 'context-interpretation-v1',
        speaker: { kind: 'personal' }, object, relation, explicit: null,
        actingSubject: f.actorA }), 200);
    expect(readableBase).toMatchObject({ state: 'resolved', definition: privateDefinition });
    f.faultNextContextChainRead(hidden.semanticRevision);
    const missingBase = await f.json<{ state: string }>(await f.call('POST',
      '/v1/context-interpretations', { profile: 'context-interpretation-v1',
        speaker: { kind: 'personal' }, object, relation, explicit: null,
        actingSubject: f.actorA }), 200);
    expect(missingBase).toMatchObject({ state: 'unavailable' });
    expect(JSON.stringify(missingBase)).not.toContain(privateDefinition);
    await f.revoke(restoredBaseGrant);
    await f.revoke(childReadGrant);

    await f.grant('context:create:global', 'context.create');
    const global = await f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'global', disclosure: 'public', base: null,
      entries: [{ target: object, relation, state: 'defined', definition: nativeId(), applicability: [] }],
      actingSubject: f.actorA }), 201);
    expect(global.context).toBe('urn:rezics:semantic-context:global');
    const unresolved = await f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
      entries: [{ target: object, relation, state: 'unresolved', definition: null, applicability: [] }],
      actingSubject: f.actorA }), 201);
    const realm = await f.realm('Unresolved selection');
    await f.grant(`context:select:${realm.realm}`, 'context.select');
    await f.json(await f.call('POST', `/v1/realms/${realm.realm.split('/').at(-1)}/context-selections`, {
      profile: 'context-selection-v1', scope: { kind: 'object', object },
      selection: { context: unresolved.context, semanticRevision: unresolved.semanticRevision },
      expectedHead: null, actingSubject: f.actorA }), 201);
    const preview = await f.json<{ state: string; context: string }>(await f.call('POST',
      '/v1/context-interpretations', { profile: 'context-interpretation-v1',
        speaker: { kind: 'realm', realm: realm.realm }, object, relation,
        explicit: null, actingSubject: f.actorA }), 200);
    expect(preview).toMatchObject({ state: 'unresolved', context: unresolved.context });
    await f.grant(`statement:speak:${realm.realm}`, 'statement.record');
    const blocked = await f.call('POST', '/v1/statements', {
      profile: 'statement-v1', speaker: { kind: 'realm', realm: realm.realm }, subject: work.mainVersion,
      predicate: relation, relationDefinition: nativeId(), value: { kind: 'resource', iri: object },
      applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: f.actorA });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: 'interpretation_unresolved',
      interpretation: { state: 'unresolved', context: unresolved.context } });
  } finally { await f.close(); }
}, 120_000);

test('CTX02/CTX03: exact Statement decisions inherit Global, suppress on local reject and fail closed', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    await f.globalAcceptance();
    const realmA = await f.realm('Decision A');
    const realmB = await f.realm('Decision B');
    const work = await f.work('Decision subject');
    if (!work.mainVersion) throw new Error('Work fixture failed');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    const relationDefinition = nativeId();
    const value = nativeId();
    const statementBody = (definition: string) => ({
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.mainVersion,
      predicate: `${RV}classifiedAs`, relationDefinition: definition,
      value: { kind: 'resource', iri: value }, applicability: [],
      interpretation: { kind: 'selected' }, evidence: [], actingSubject: f.actorA });
    const recorded = await f.json<StatementWrite>(await f.call('POST', '/v1/statements',
      statementBody(relationDefinition)), 201);
    const changedCriterion = await f.json<StatementWrite>(await f.call('POST', '/v1/statements',
      statementBody(nativeId())), 201);
    expect(changedCriterion.meaningKey).not.toBe(recorded.meaningKey);
    const target = { kind: 'statement', statement: recorded.statement };
    const acceptance = (realm?: string) => realm ? { kind: 'realm', realm } : { kind: 'global' };
    const resolve = async (realm?: string) => f.json<Resolution>(await f.call('POST',
      '/v1/statement-resolutions', { profile: 'statement-resolution-v1', target,
        acceptance: acceptance(realm) }), 200);
    const denied = await f.grant('classification:decide:global', 'statement.decide');
    await f.revoke(denied);
    const globalDecision = { profile: 'statement-decision-v1', target, acceptance: acceptance(),
      expectedDecisionHead: null, outcome: 'accepted', actingSubject: f.actorA };
    expect((await f.call('POST', '/v1/statement-decisions', globalDecision)).status).toBe(403);
    await f.grant('classification:decide:global', 'statement.decide');
    const globalKey = randomUUID();
    const accepted = await f.json<DecisionWrite>(await f.call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target, acceptance: acceptance(),
      expectedDecisionHead: null, outcome: 'accepted', actingSubject: f.actorA }, globalKey), 201);
    expect(await f.json<DecisionWrite>(await f.call('POST', '/v1/statement-decisions',
      globalDecision, globalKey), 200)).toMatchObject({ decision: accepted.decision, replayed: true });
    const acceptedBatch = await readNextMainOutboxBatch(f.env.fuseki, accepted.sourcePosition.dataEpoch,
      (BigInt(accepted.sourcePosition.sequence) - 1n).toString());
    expect(acceptedBatch?.sequence).toBe(accepted.sourcePosition.sequence);
    const acceptedEvent = await readMainOutboxEnvelope(f.env.fuseki, acceptedBatch!, acceptedBatch!.eventIds[0]!);
    expect(acceptedEvent).toMatchObject({ type: 'com.rezics.statement.decision-changed.v1',
      data: { receipt: { action: 'statement.decide', outcome: 'succeeded', component: accepted.slot,
        revision: accepted.decision } } });
    expect((await resolve()).result).toMatchObject({ state: 'accepted', source: 'global',
      decision: accepted.decision });
    expect((await resolve(realmA.realm)).result).toMatchObject({ state: 'accepted',
      source: 'inherited-global', decision: accepted.decision });
    await f.grant(`classification:decide:${realmA.realm}`, 'statement.decide');
    const rejected = await f.json<DecisionWrite>(await f.call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target, acceptance: acceptance(realmA.realm),
      expectedDecisionHead: null, outcome: 'rejected', actingSubject: f.actorA }), 201);
    expect((await resolve(realmA.realm)).result).toMatchObject({ state: 'rejected', source: 'local',
      decision: rejected.decision });
    expect((await resolve(realmB.realm)).result).toMatchObject({ state: 'accepted',
      source: 'inherited-global', decision: accepted.decision });
    expect((await f.json<Resolution>(await f.call('POST', '/v1/statement-resolutions', {
      profile: 'statement-resolution-v1', target: { kind: 'statement', statement: changedCriterion.statement },
      acceptance: acceptance(realmB.realm) }), 200)).result).toEqual({ state: 'absent', source: 'none' });
    expect((await resolve()).result).toMatchObject({ state: 'accepted', source: 'global' });
    for (const fault of ['missing-outcome', 'failed-read'] as const) {
      f.faultNextLocalDecisionRead(fault);
      const response = await f.call('POST', '/v1/statement-resolutions', {
        profile: 'statement-resolution-v1', target, acceptance: acceptance(realmA.realm) });
      expect(response.status).toBe(fault === 'missing-outcome' ? 200 : 503);
      const body = JSON.stringify(await response.json());
      if (fault === 'missing-outcome') expect(JSON.parse(body).result).toEqual({ state: 'unavailable' });
      expect(body).not.toContain(rejected.decision);
      expect(body).not.toContain(accepted.decision);
    }
    const stale = await f.call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target, acceptance: acceptance(realmA.realm),
      expectedDecisionHead: null, outcome: 'accepted', actingSubject: f.actorA }, randomUUID());
    expect(stale.status).toBe(409);
    const staleBatch = await readNextMainOutboxBatch(f.env.fuseki, rejected.sourcePosition.dataEpoch,
      rejected.sourcePosition.sequence);
    const staleEvent = await readMainOutboxEnvelope(f.env.fuseki, staleBatch!, staleBatch!.eventIds[0]!);
    expect(staleEvent).toMatchObject({ type: 'com.rezics.statement.decision-stale.v1',
      data: { receipt: { action: 'statement.decide', outcome: 'cancelled', reason: 'stale-head' } } });
    const raceBody = (outcome: 'accepted' | 'withdrawn') => ({
      profile: 'statement-decision-v1', target, acceptance: acceptance(realmA.realm),
      expectedDecisionHead: rejected.decision, outcome, actingSubject: f.actorA });
    const raceCommands = [
      f.call.bind(f, 'POST', '/v1/statement-decisions', raceBody('accepted'), randomUUID()),
      f.call.bind(f, 'POST', '/v1/statement-decisions', raceBody('withdrawn'), randomUUID()),
    ];
    await assertCommandRace(await Promise.all(raceCommands.map((send) => send())), 201, (index) =>
      raceCommands[index]!(),
    );
    const withdrawal = { profile: 'statement-v1', speaker: { kind: 'personal' },
      expectedHead: recorded.revision, actingSubject: f.actorA };
    const withdrawalPath = `/v1/statements/${recorded.statement.split('/').at(-1)}/withdrawals`;
    await f.revoke(await f.grant(`statement:speak:${f.actorA}`, 'statement.withdraw'));
    expect((await f.call('POST', withdrawalPath, withdrawal)).status).toBe(403);
    await f.grant(`statement:speak:${f.actorA}`, 'statement.withdraw');
    const withdrawalKey = randomUUID();
    const withdrawn = await f.json<{ revision: string; replayed: boolean;
      sourcePosition: { dataEpoch: string; sequence: string } }>(await f.call('POST',
      withdrawalPath, withdrawal, withdrawalKey), 201);
    expect(await f.json<typeof withdrawn>(await f.call('POST', withdrawalPath, withdrawal,
      withdrawalKey), 200)).toMatchObject({ revision: withdrawn.revision, replayed: true });
    expect((await f.json<{ state: string; revision: string }>(await f.call('GET',
      `/v1/statements/${recorded.statement.split('/').at(-1)}`), 200)))
      .toMatchObject({ state: 'withdrawn', revision: withdrawn.revision });
    expect((await resolve()).result).toEqual({ state: 'unavailable' });
    expect((await resolve(realmB.realm)).result).toEqual({ state: 'unavailable' });
    const withdrawalBatch = await readNextMainOutboxBatch(f.env.fuseki,
      withdrawn.sourcePosition.dataEpoch, (BigInt(withdrawn.sourcePosition.sequence) - 1n).toString());
    const withdrawalEvent = await readMainOutboxEnvelope(f.env.fuseki, withdrawalBatch!,
      withdrawalBatch!.eventIds[0]!);
    expect(withdrawalEvent).toMatchObject({ type: 'com.rezics.statement.withdrawn.v1',
      data: { receipt: { action: 'statement.withdraw', outcome: 'succeeded',
        component: recorded.statement, revision: withdrawn.revision } } });
    expect((await f.call('POST', withdrawalPath, withdrawal)).status).toBe(409);
  } finally { await f.close(); }
}, 120_000);
