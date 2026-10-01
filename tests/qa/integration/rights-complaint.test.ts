import { claimFixture, fixtureReasons } from './g-565-decision-support.ts';
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
import { authorCreditFixture, author, shortId } from '../fixtures/author-credit.ts';

const agent = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test('LIVE18: a complaint fence survives synopsis refresh and human confirmation while facts and Work identity survive',
  async () => {
    if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use the QA integration tier');
    const directory = join(resolve(import.meta.dir, '../../..'), '.temp', `rights-synopsis-${randomUUID()}`);
    const scopes = 'openid work:create work:edit work:read work:protect source:intake source:acquire '
      + 'source:convert source:propose source:adopt source:correspond source:read governance:report rights:decide';
    const h = await authorCreditFixture(Bun.env as Record<string, string>, directory, scopes);
    try {
      const initial = await h.propose('OL993418W', [author('/authors/OL1A')],
        'Independently supported title', 'Restricted copied synopsis', ['history']);
      const work = await h.adoptWork(initial);
      await h.grant(`work:edit:${work.work}`, 'work.edit');
      await h.grant(`work:read:${work.work}`, 'work.read');
      const path = `/v1/works/${shortId(work.work)}/fields/synopsis/control`;
      const read = async () => h.json<{ work: string; workHead: string; contentHead: string | null;
        controlHead: string | null; controlEpoch: string; protectionHead: string | null;
        value: string | null; rightsStatus: string | null }>(
        await h.call('GET', `${path}?actingSubject=${encodeURIComponent(h.actor)}`), 200);
      const before = await read();
      const basis = (state: typeof before) => ({ contentHead: state.contentHead,
        head: state.controlHead, epoch: state.controlEpoch, protection: state.protectionHead });
      const sourceIntent = (proposal: typeof initial, value: string, state: typeof before) => ({
        profile: 'work-editorial-field-control-v1', field: 'synopsis',
        expectedWorkHead: work.workRevision, basis: basis(state), value, origin: 'source',
        source: { record: proposal.record, observation: proposal.observation,
          conversion: proposal.conversion, mapping: 'open-library-work-map-v1' },
        actingSubject: h.actor });
      h.failFieldCertificate();
      expect((await h.call('POST', path, sourceIntent(initial, 'Restricted copied synopsis', before))).status).toBe(503);
      const imported = await read();
      expect(imported.value).toBe('Restricted copied synopsis');
      expect((await h.pool.query<{ pending_step_id: string }>(`SELECT h.pending_step_id
        FROM source.field_support s JOIN source.field_support_head h ON h.support_id = s.id
        WHERE s.target = $1 AND s.slot = 'work-editorial-field-v1#synopsis'`,
      [work.work])).rows[0]?.pending_step_id).not.toBeNull();

      const scope = 'governance:platform:source-synopsis';
      await h.grant(scope, 'governance.appeal');
      const decider = agent();
      await h.accessPool.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')`, [decider]);
      await h.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await h.accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,'governance.rights.decide',now() + interval '1 hour')`,
      [randomUUID(), h.otherPrincipal, decider]);
      await h.accessPool.query(`INSERT INTO access.permission_grant
        (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,'governance.rights.decide',now() + interval '1 hour')`,
      [randomUUID(), decider, scope]);
      const evidence = [{ owner: 'source', resource: initial.record, component: 'synopsis',
        revision: initial.observation, locator: null }];
      const complaintKey = randomUUID(), decisionKey = randomUUID();
      const complaint = await h.json<{ caseId: string; evidenceDigest: string }>(await h.call('POST',
        '/v1/rights/complaints', { profile: 'rights-complaint-v1', actingSubject: h.actor,
          authority: { kind: 'platform', scopeId: scope }, context: 'urn:rezics:context:global',
          target: { owner: 'source', resource: initial.record, component: 'synopsis' },
          disclosure: 'parties', reasonCode: 'claimed_synopsis', statement: 'Copied synopsis is disputed.',
          evidence, idempotencyKey: complaintKey, complaint: { process: 'dmca_512',
            claimantKind: 'rights_holder', claimantName: 'Fixture claimant', claimantContact: null,
            claimedWork: 'Restricted synopsis', claimedRight: 'copyright',
            noticeDigest: digest('synopsis notice'), noticeReceivedAt: new Date().toISOString() } },
        complaintKey), 201);
      const targets = ['disclosure', 'source_apply', 'search', 'export'].map(effect => ({
        owner: 'source', resource: initial.record, component: 'synopsis', locator: null,
        scopeKind: 'component', revision: null, expectedHead: null, effect }));
      await claimFixture(h.accessPool, complaint.caseId, h.otherPrincipal, decider);
      const restrictionInput = { profile: 'rights-restriction-v1', outcome: 'interim_restrict',
          caseId: complaint.caseId, expectedGeneration: '0', actingSubject: decider,
          targets, rule: { ref: 'urn:rezics:rule:source-rights', revision: 'v1', digest: h.ruleDigest },
          evidenceDigest: complaint.evidenceDigest, reversesDecisionId: null, answersStepId: null,
          reasons: fixtureReasons, rationale: 'Restrict copied synopsis while the claim is reviewed.', disclosure: 'parties',
          idempotencyKey: decisionKey };
      await h.json(await h.call('POST', '/v1/rights/restrictions', restrictionInput, decisionKey, h.account.tokenB), 202);
      const decision = await h.json<{ enforcement: Array<{ state: string }> }>(await h.call('POST',
        '/v1/rights/restrictions', restrictionInput, decisionKey, h.account.tokenB), 200);
      expect(decision.enforcement).toHaveLength(4);
      expect(decision.enforcement.every(item => item.state === 'restricted')).toBe(true);

      const fenced = await read();
      expect(fenced).toMatchObject({ work: work.work, workHead: work.workRevision,
        value: null, rightsStatus: 'restricted', controlHead: imported.controlHead });
      const refreshed = await h.propose('OL993418W', [author('/authors/OL1A')],
        'Independently supported title', 'Refreshed copied synopsis', ['history']);
      expect(refreshed.record).toBe(initial.record);
      expect((await h.call('POST', path, sourceIntent(refreshed, 'Refreshed copied synopsis', imported))).status)
        .toBe(403);
      expect((await h.call('POST', path, { ...sourceIntent(initial, 'Restricted copied synopsis', imported),
        origin: 'human', source: null })).status).toBe(403);
      expect(await read()).toEqual(fenced);
      const independentlyWritten = await h.json<{ content: string }>(await h.call('POST', path,
        { ...sourceIntent(initial, 'A new independent synopsis', imported), origin: 'human', source: null }), 201);
      const afterHuman = await read();
      expect(afterHuman).toMatchObject({ work: work.work, workHead: work.workRevision,
        value: 'A new independent synopsis', rightsStatus: 'undetermined', mode: 'human-controlled' });
      expect(afterHuman.contentHead).toBe(independentlyWritten.content);
      expect((await h.call('POST', path, { ...sourceIntent(initial, 'Restricted copied synopsis', afterHuman),
        origin: 'human', source: null })).status).toBe(403);
      const sourceObservation = await h.intake.read(h.principalId, shortId(refreshed.observation));
      expect(sourceObservation?.record).toBe(initial.record);
      expect(JSON.parse(Buffer.from(sourceObservation!.rawBytesBase64!, 'base64').toString('utf8')))
        .toMatchObject({ title: 'Independently supported title', subjects: ['history'] });
      expect(await h.rightsStore.sourceSynopsisRestricted(initial.record, refreshed.observation,
        ['source_apply'])).toBe(true);
      // The native provenance probe stays bounded as unrelated source supports grow.
      const probe = async () => {
        const row = (await h.pool.query<{ 'QUERY PLAN': Array<{ Plan: {
          'Actual Rows': number; 'Shared Hit Blocks': number; 'Shared Read Blocks': number;
          'Temp Read Blocks': number } }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
          SELECT DISTINCT 'https://rezics.com/id/' || s.record_id AS record,
            'https://rezics.com/id/' || c.observation_id AS observation
          FROM source.field_support s
          JOIN source.field_support_step st ON st.support_id = s.id
          LEFT JOIN source.field_support_outcome out ON out.step_id = st.id
          JOIN source.conversion c ON c.id = st.conversion_id
          WHERE s.target = $1 AND s.slot = 'work-editorial-field-v1#synopsis'
            AND s.context = 'global' AND st.value_digest = $2
            AND (out.outcome = 'applied' OR out.step_id IS NULL) LIMIT 65`,
        [work.work, digest(JSON.stringify('Restricted copied synopsis'))])).rows[0]!['QUERY PLAN'][0]!.Plan;
        expect(row['Actual Rows']).toBe(1);
        expect(row['Temp Read Blocks']).toBe(0);
        return row['Shared Hit Blocks'] + row['Shared Read Blocks'];
      };
      const smallBuffers = await probe();
      await h.pool.query(`INSERT INTO source.field_support
        (id,principal_id,target,slot,occurrence,context,record_id)
        SELECT gen_random_uuid(),$1,'https://rezics.com/id/' || gen_random_uuid(),
          'work-editorial-field-v1#synopsis',NULL,'global',$2
        FROM generate_series(1,512)`, [h.principalId, shortId(initial.record)]);
      await h.pool.query('ANALYZE source.field_support');
      expect(await probe()).toBeLessThanOrEqual(smallBuffers + 32);
    } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 120_000);

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
      let clock = new Date();
      const store = new GovernanceStore(access, ownerEvidenceCapture({ source: async (principal, recordId,
        observationId) => {
        const id = principals.get(principal.subject);
        const value = id ? await source.read(id, observationId) : null;
        return value && value.record.endsWith(recordId) ? { record: value.record, retention: value.retention,
          byteDigest: value.byteDigest, mediaType: value.mediaType } : null;
      } }), { current: async () => null }, { current: async ref => rules.get(ref) ?? null }, undefined, undefined, () => clock);
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
        reasons: fixtureReasons, rationale: 'Synopsis access restriction pending process.', disclosure: 'parties', idempotencyKey });
      const restrict = async (body: object) => {
        await claimFixture(access, complaint.body.caseId, principals.get(account.b.id)!, decider);
        // Match the injected decision clock for a staff claim after the legal wait.
        await access.query('UPDATE access.safety_case_claim SET claimed_at = $2,expires_at = $3 WHERE case_id = $1',
          [complaint.body.caseId, clock, new Date(clock.getTime() + 30 * 60_000)]);
        const accepted = await call('/v1/rights/restrictions', account.tokenB, body);
        if (accepted.status !== 202) return accepted;
        expect(accepted.body.operation.status).toBe('accepted');
        return call('/v1/rights/restrictions', account.tokenB, body);
      };
      const interim = await restrict(decision('interim_restrict', '0', null, 'interim-cover'));
      expect(interim.status, JSON.stringify(interim.body)).toBe(200);
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
      expect(final.status, JSON.stringify(final.body)).toBe(200);
      const replayedFinal = await restrict(decision('final_restrict', '1', null, 'final-synopsis'));
      expect(replayedFinal.status).toBe(200);
      expect(replayedFinal.body).toMatchObject({ decisionId: final.body.decisionId, replayed: true });
      const earliest = new Date(clock.getTime() + 14 * 86_400_000);
      const windowStep = (kind: 'restoration_not_before' | 'restoration_not_after', dueAt: Date) => store.recordStep(
        { issuer: account.issuer, subject: account.b.id }, { caseId: complaint.body.caseId,
          decisionId: final.body.decisionId, actingSubject: decider, process: 'dmca_512', step: kind,
          partySubject: null, statement: null, documentDigest: null, occurredAt: new Date().toISOString(),
          dueAt: dueAt.toISOString(), idempotencyKey: kind });
      await windowStep('restoration_not_before', earliest);
      await windowStep('restoration_not_after', new Date(earliest.getTime() + 4 * 86_400_000));
      expect((await restrict(decision('restore', '2', counter.body.stepId, 'before-earliest'))).status).toBe(409);
      clock = new Date(earliest.getTime() + 5 * 86_400_000);
      expect((await restrict(decision('restore', '2', null, 'unanswered-restore'))).status).toBe(400);
      const restored = await restrict(decision('restore', '2', counter.body.stepId, 'answered-restore'));
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
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
