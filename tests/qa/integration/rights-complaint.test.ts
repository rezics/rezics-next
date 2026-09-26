import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ownerEvidenceCapture } from '../../../services/main/src/modules/governance/evidence.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { RightsStore, rightsExportUseScope } from '../../../services/main/src/modules/rights/store.ts';
import { planExport, type VerifiedExportMember } from '../../../services/main/src/modules/export/planner.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { reportRoutes } from '../../../services/main/src/routes/reports.ts';
import { rightsRoutes } from '../../../services/main/src/routes/rights.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { ratingAccount } from '../support/rating-account.ts';

const agent = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test('GOV24/GOV25/LIVE17/LIVE18: a source synopsis restriction stays exact through decision replay and refresh',
  async () => {
    if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use the QA integration tier');
    const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['account', 'access', 'content']);
    const access = new Pool({ connectionString: databases.urls.access, max: 6 });
    const content = new Pool({ connectionString: databases.urls.content, max: 4 });
    try {
      await migrateContent(content);
      const account = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as
        Record<string, string>, 'openid governance:report rights:decide rights:assess');
      const source = new SourceIntakeStore(content);
      const principals = new Map([[account.a.id, randomUUID()], [account.b.id, randomUUID()]]);
      for (const [subject, id] of principals) {
        await access.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
          [id, account.issuer, subject]);
      }
      const submitter = agent();
      const decider = agent();
      const scope = 'governance:platform:source-complaints';
      await access.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
      const grant = async (subject: string, actor: string, action: string) => {
        await access.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')
          ON CONFLICT DO NOTHING`, [actor]);
        await access.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
          VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
        [randomUUID(), principals.get(subject), actor, action]);
        await access.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id,
          action, valid_until) VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
        [randomUUID(), actor, scope, action]);
      };
      await grant(account.a.id, submitter, 'governance.appeal');
      await grant(account.b.id, decider, 'governance.rights.decide');
      await access.query(`INSERT INTO access.scope_gate (id) VALUES ('rights:assess') ON CONFLICT DO NOTHING`);
      await access.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id,
        action, valid_until) VALUES ($1, $2, $2, 'rights:assess', 'rights.assess', now() + interval '1 hour')`,
      [randomUUID(), submitter]);

      const intake = (revision: string) => source.submit(principals.get(account.a.id)!, `intake-${revision}`,
        { provider: 'fixture', namespace: 'book', externalId: 'reported-book', sourceRevision: revision,
          mediaType: 'application/json', retention: 'retained',
          rawBytesBase64: Buffer.from(JSON.stringify({ cover: 'reported-cover', synopsis: 'independent-text',
            facts: ['first-publication'] })).toString('base64'),
          coverage: { scope: 'source-record', complete: true, omittedFields: [] },
          rightsEvidence: { basis: 'unknown', note: 'No license assertion' } });
      const observed = (await intake('r1')).observation;
      const rules = new Map([['urn:rezics:rule:source-rights', { revision: 'v1', digest: digest('rule-v1') }]]);
      const store = new GovernanceStore(access, ownerEvidenceCapture({ source: async (principal, recordId,
        observationId) => {
        const id = principals.get(principal.subject);
        const value = id ? await source.read(id, observationId) : null;
        return value && value.record.endsWith(recordId) ? { record: value.record, retention: value.retention,
          byteDigest: value.byteDigest, mediaType: value.mediaType } : null;
      } }), { current: async () => null }, { current: async ref => rules.get(ref) ?? null });
      const rightsStore = new RightsStore(content, access);
      const deps = { account: account.verifier, governance: { store }, rights: { store: rightsStore } } as unknown as MainWorkDependencies;
      const app = new Elysia().use(reportRoutes(deps)).use(rightsRoutes(deps));
      const call = async (path: string, token: string, body: object) => {
        const response = await app.handle(new Request(`http://main.local${path}`, { method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
            ...('idempotencyKey' in body ? { 'idempotency-key': String(body.idempotencyKey) } : {}) },
          body: JSON.stringify(body) }));
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
      };
      const sourceRecordId = observed.record.split('/').at(-1)!;
      const synopsisMaterial = { scopeKind: 'source_record', provider: null, namespace: null,
        sourceRecordId, contentVariantId: null, mediaAsset: null, component: 'synopsis' } as const;
      const factMaterial = { ...synopsisMaterial, component: 'record' };
      const synopsisAssessment = await call('/v1/rights/use-assessments', account.tokenA, {
        profile: 'rights-use-assessment-v1', actingSubject: submitter, material: synopsisMaterial,
        expressionKind: 'expression', family: 'data_rights', useKind: 'export',
        useScope: rightsExportUseScope('full'), basis: 'unknown', outcome: 'undetermined',
        licenseInstrument: null, exceptionKind: null, rationale: null, extent: {}, evidence: {}, obligations: [],
        expectedAssessment: null, idempotencyKey: 'source-synopsis-export-unknown',
      });
      expect(synopsisAssessment.status, JSON.stringify(synopsisAssessment.body)).toBe(201);
      const factsAssessment = await call('/v1/rights/use-assessments', account.tokenA, {
        profile: 'rights-use-assessment-v1', actingSubject: submitter, material: factMaterial,
        expressionKind: 'fact', family: 'data_rights', useKind: 'export',
        useScope: rightsExportUseScope('full'), basis: 'unprotected_fact', outcome: 'supported',
        licenseInstrument: null, exceptionKind: null, rationale: null, extent: {},
        evidence: { sourceObservation: observed.observation, field: 'facts', digest: observed.byteDigest }, obligations: [],
        expectedAssessment: null, idempotencyKey: 'source-record-export-unknown',
      });
      expect(factsAssessment.status, JSON.stringify(factsAssessment.body)).toBe(201);
      const sourceExportMember = (component: string, material: object,
        revision: string, revisionDigest: string): VerifiedExportMember => ({
        sourceOwner: 'source', sourceNamespace: 'fixture:book', sourceGrain: 'source_observation',
        exactRef: revision, contentRevisionId: null, refDigest: revisionDigest,
        ownerDataEpoch: 'fixture-epoch', ownerSequence: '1', sourcePosition: null,
        targetGrain: 'source-record', mapping: 'exact', data: { rightsIdentity: {
          material, target: { owner: 'source', resource: observed.record, component, revision } } },
      });
      const synopsisMember = sourceExportMember('synopsis', synopsisMaterial,
        observed.observation, observed.byteDigest!);
      const factsMember = sourceExportMember('record', factMaterial,
        observed.observation, observed.byteDigest!);
      const evidence = [{ owner: 'source', resource: observed.record, component: 'synopsis',
        revision: observed.observation, locator: null }];
      const complaint = await call('/v1/rights/complaints', account.tokenA, {
        profile: 'rights-complaint-v1', actingSubject: submitter,
        authority: { kind: 'platform', scopeId: scope }, context: 'urn:rezics:context:global',
        target: { owner: 'source', resource: observed.record, component: 'synopsis' },
        disclosure: 'parties', reasonCode: 'claimed_synopsis', statement: 'This synopsis is disputed.',
        evidence, idempotencyKey: 'synopsis-complaint', complaint: { process: 'dmca_512',
          claimantKind: 'rights_holder', claimantName: 'Fixture claimant', claimantContact: null,
          claimedWork: 'Reported book synopsis', claimedRight: 'copyright',
          noticeDigest: digest('fixture notice'), noticeReceivedAt: new Date().toISOString() },
      });
      expect(complaint.status, JSON.stringify(complaint.body)).toBe(201);
      expect(complaint.body.evidence).toEqual([expect.objectContaining({ owner: 'source', component: 'synopsis',
        revision: observed.observation, state: 'available', revisionDigest: observed.byteDigest })]);
      expect((await access.query('SELECT process, claimed_right FROM access.rights_complaint WHERE report_id = $1',
        [complaint.body.reportId])).rows[0]).toMatchObject({ process: 'dmca_512', claimed_right: 'copyright' });
      // A different Account cannot report a private observation it cannot read.
      expect((await call('/v1/rights/complaints', account.tokenB, { profile: 'rights-complaint-v1',
        actingSubject: decider, authority: { kind: 'platform', scopeId: scope },
        context: 'urn:rezics:context:global', target: { owner: 'source', resource: observed.record,
          component: 'synopsis' }, disclosure: 'private', reasonCode: 'claimed_synopsis', statement: null,
        evidence, idempotencyKey: 'foreign-complaint', complaint: { process: 'dmca_512',
          claimantKind: 'unknown', claimantName: 'Other', claimantContact: null, claimedWork: 'Book',
          claimedRight: 'copyright', noticeDigest: digest('foreign'), noticeReceivedAt: new Date().toISOString() },
      })).status).toBe(403);

      const targets = ['export', 'media_delivery', 'search', 'source_apply'].map(effect => ({ owner: 'source',
        resource: observed.record, component: 'synopsis', locator: null, scopeKind: 'component',
        revision: null, expectedHead: null, effect }));
      const decision = (outcome: string, generation: string, answersStepId: string | null,
        idempotencyKey: string) => ({ profile: 'rights-restriction-v1', outcome,
        caseId: complaint.body.caseId, expectedGeneration: generation, actingSubject: decider,
        targets, rule: { ref: 'urn:rezics:rule:source-rights', revision: 'v1', digest: digest('rule-v1') },
        evidenceDigest: complaint.body.evidenceDigest, reversesDecisionId: null, answersStepId,
        rationale: 'Synopsis access restriction pending process.', disclosure: 'parties', idempotencyKey });
      const restrict = (body: object) => call('/v1/rights/restrictions', account.tokenB, body);
      const interim = await restrict(decision('interim_restrict', '0', null, 'interim-cover'));
      expect(interim.status, JSON.stringify(interim.body)).toBe(201);
      expect(interim.body.enforcement).toHaveLength(4);
      expect(interim.body.enforcement.every((item: { state: string }) => item.state === 'restricted')).toBe(true);
      expect(await store.readEnforcement({ owner: 'source', resource: observed.record, component: 'synopsis' }))
        .not.toEqual([]);
      expect(await store.readEnforcement({ owner: 'source', resource: observed.record, component: 'record' }))
        .toEqual([]);
      // A complaint is not a blanket right to restrict an unrelated component.
      expect((await restrict({ ...decision('final_restrict', '1', null, 'wrong-component'), targets: [{
        ...targets[0], component: 'cover' }] })).status).toBe(403);
      const beforeRefresh = await planExport({ targetProfile: 'rezics-source-v1', useScope: 'full',
        members: [synopsisMember, factsMember], residuals: [] }, rightsStore.exportScope);
      expect(beforeRefresh.licenseScope).toBe('blocked');
      expect(beforeRefresh.bases).toEqual(expect.arrayContaining([
        expect.objectContaining({ basisKind: 'unprotected_fact', result: 'supported', memberOrdinals: [2] }),
      ]));

      const step = (kind: string, actingSubject: string, partySubject: string | null, key: string) =>
        ({ profile: 'governance-process-step-v1', caseId: complaint.body.caseId,
          decisionId: interim.body.decisionId, actingSubject, process: 'dmca_512', step: kind,
          partySubject, statement: `${kind} recorded`, documentDigest: digest(key),
          occurredAt: new Date().toISOString(), dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          idempotencyKey: key });
      expect((await call('/v1/governance/process-steps', account.tokenB,
        step('uploader_notice', decider, submitter, 'uploader-notice'))).status).toBe(201);
      const counter = await call('/v1/governance/process-steps', account.tokenA,
        step('counter_notice', submitter, submitter, 'counter-notice'));
      expect(counter.status, JSON.stringify(counter.body)).toBe(201);
      // A counter-notice and refresh cannot release the committed fence by themselves.
      const refreshed = (await intake('r2')).observation;
      expect(refreshed.record).toBe(observed.record);
      expect(refreshed.observation).not.toBe(observed.observation);
      expect((await store.readEnforcement({ owner: 'source', resource: observed.record, component: 'synopsis' }))
        .every(item => item.state === 'restricted')).toBe(true);
      const replayedIntake = await intake('r1');
      expect(replayedIntake.replayed).toBe(true);
      expect(replayedIntake.observation.observation).toBe(observed.observation);
      const retainedRefresh = await source.read(principals.get(account.a.id)!, refreshed.observation.split('/').at(-1)!);
      expect(JSON.parse(Buffer.from(retainedRefresh!.rawBytesBase64!, 'base64').toString('utf8')))
        .toMatchObject({ facts: ['first-publication'], synopsis: 'independent-text' });
      const refreshedMember = sourceExportMember('synopsis', synopsisMaterial,
        refreshed.observation, refreshed.byteDigest!);
      // Reaffirm the independently supported fact against the new source snapshot. This
      // human assessment advances its own use head; it cannot clear the synopsis fence.
      const refreshedFactsAssessment = await call('/v1/rights/use-assessments', account.tokenA, {
        profile: 'rights-use-assessment-v1', actingSubject: submitter, material: factMaterial,
        expressionKind: 'fact', family: 'data_rights', useKind: 'export',
        useScope: rightsExportUseScope('full'), basis: 'unprotected_fact', outcome: 'supported',
        licenseInstrument: null, exceptionKind: null, rationale: null, extent: {},
        evidence: { sourceObservation: refreshed.observation, field: 'facts', digest: refreshed.byteDigest }, obligations: [],
        expectedAssessment: factsAssessment.body.assessmentId, idempotencyKey: 'source-record-export-refreshed',
      });
      expect(refreshedFactsAssessment.status, JSON.stringify(refreshedFactsAssessment.body)).toBe(201);
      expect(refreshedFactsAssessment.body.predecessor).toBe(factsAssessment.body.assessmentId);
      const refreshedFacts = sourceExportMember('record', factMaterial,
        refreshed.observation, refreshed.byteDigest!);
      expect(refreshedFacts.data?.rightsIdentity).toMatchObject({ target: {
        owner: 'source', resource: observed.record, component: 'record' } });
      const refreshedPlan = await planExport({ targetProfile: 'rezics-source-v1', useScope: 'full',
        members: [refreshedMember, refreshedFacts], residuals: [] }, rightsStore.exportScope);
      expect(refreshedPlan.licenseScope).toBe('blocked');
      expect(refreshedPlan.bases).toEqual(expect.arrayContaining([
        expect.objectContaining({ basisKind: 'unprotected_fact', result: 'supported', memberOrdinals: [2] }),
        expect.objectContaining({ result: 'prohibited', obligations: ['access_restriction'], memberOrdinals: [1] }),
      ]));
      const final = await restrict(decision('final_restrict', '1', null, 'final-synopsis'));
      expect(final.status, JSON.stringify(final.body)).toBe(201);
      const replayedFinal = await restrict(decision('final_restrict', '1', null, 'final-synopsis'));
      expect(replayedFinal.status).toBe(200);
      expect(replayedFinal.body).toMatchObject({ decisionId: final.body.decisionId, replayed: true });
      expect((await restrict(decision('restore', '2', null, 'unanswered-restore'))).status).toBe(400);
      const restored = await restrict(decision('restore', '2', counter.body.stepId, 'answered-restore'));
      expect(restored.status, JSON.stringify(restored.body)).toBe(201);
      expect(restored.body.enforcement.every((item: { state: string }) => item.state === 'released')).toBe(true);
      expect((await restrict(decision('restore', '2', counter.body.stepId, 'stale-restore'))).status).toBe(409);
      expect((await access.query(`SELECT outcome FROM access.moderation_decision WHERE case_id = $1
        ORDER BY case_sequence`, [complaint.body.caseId])).rows.map(row => row.outcome))
        .toEqual(['interim_restrict', 'final_restrict', 'restore']);
    } finally {
      await Promise.all([access.end(), content.end()]);
      await databases.close();
    }
  }, 180_000);
