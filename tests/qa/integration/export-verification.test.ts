import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { ExportStore } from '../../../services/main/src/modules/export/store.ts';
import { claimDigest, createClaim, readAssessment, readReceipt, recordAssessment }
  from '../../../services/main/src/modules/verification/graph.ts';
import { SUPPORT_METHOD, SUMMARY_POLICY } from '../../../services/main/src/modules/verification/analysis.ts';
import { VerificationStore } from '../../../services/main/src/modules/verification/store.ts';
import { exportRoutes } from '../../../services/main/src/routes/exports.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { ratingAccount } from '../support/rating-account.ts';

const root = resolve(import.meta.dir, '../../..');
const agent = () => `https://rezics.com/id/${randomUUID()}`;

test('FACT05: exact claim and assessment export retains method output while redacting private evidence anchors',
  async () => {
    const runId = Bun.env.REZICS_QA_RUN_ID;
    if (!runId || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
      throw new Error('Use the isolated QA integration tier');
    }
    const databases = await cloneQaOwnerDatabases(runId, ['account', 'access', 'content']);
    const accessPool = new Pool({ connectionString: databases.urls.access, max: 4 });
    const contentPool = new Pool({ connectionString: databases.urls.content, max: 4 });
    const directory = join(root, '.temp', `export-verification-${randomUUID()}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let account: Awaited<ReturnType<typeof ratingAccount>> | undefined;
    try {
      await migrateContent(contentPool);
      account = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as
        Record<string, string>, 'openid export:create export:read');
      const principalId = randomUUID();
      const actor = agent();
      const environment = { fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
        lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
        objectDirectory: directory };
      const access = new AccessAdmissionRegistry(accessPool);
      const verification = new VerificationStore(contentPool);
      await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1,$2,$3)`, [principalId, account.issuer, account.a.id]);
      await accessPool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')`, [actor]);
      const grant = async (scope: string, action: string) => {
        await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
        await accessPool.query(`INSERT INTO access.representation
          (id, principal_id, subject_id, action, valid_until)
          VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principalId, actor, action]);
        await accessPool.query(`INSERT INTO access.permission_grant
          (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
          VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
      };
      const principal = await account.verifier.verify(new Request('http://main.local',
        { headers: { authorization: `Bearer ${account.tokenA}` } }), ['export:create']);
      await grant('verification:claim:global', 'verification.claim.create');
      const probeInput = { referent: 'urn:fact:export-fixture',
        interpretationContext: 'urn:context:export-fixture', propositionPredicate: 'urn:predicate:export-fixture',
        value: { kind: 'literal' as const, lexical: 'A qualified statement', datatype: 'string' as const },
        valuePrecision: 'exact' as const, valueQualifiers: ['inferred' as const], validFrom: null,
        validUntil: null, editionScope: null, actingSubject: actor };
      const probe = await access.register({ principal, actingSubject: actor, scope: 'verification:claim:global',
        action: 'verification.claim.create', idempotencyKey: `probe-${randomUUID()}`,
        requestDigest: claimDigest(probeInput) });
      const claimReceipt = await createClaim(environment,
        await access.claim(probe.id, probe.requestDigest), probeInput);
      expect(await readReceipt(environment, probe.id, 'claim-create', ['claim', 'claimRevision']))
        .not.toBeNull();
      const claim = claimReceipt.result.claim!;
      const claimRevision = claimReceipt.result.claimRevision!;
      const content = new ContentCore(contentPool);
      const privateBody = `private-source-body-${randomUUID()}`;
      const draft = await content.saveDraft({ operationId: `evidence-${randomUUID()}`,
        variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: agent(),
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
        expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
        provenance: { fixture: 'export-verification' },
        serializedJson: JSON.stringify({ body: privateBody }) });
      if (draft.outcome !== 'succeeded' || !draft.revisionId) throw new Error('Evidence draft unavailable');
      const evidence = await verification.recordEvidence(principalId, `evidence-${randomUUID()}`,
        claim, { claimRevision,
          expectedHead: null, items: [{ stance: 'supports', contentRevision: draft.revisionId,
            selector: { kind: 'whole' }, availability: 'available' }] });
      await grant('verification:assess:global', 'verification.claim.assess');
      const assessmentDigest = 'b'.repeat(64);
      const assessmentAdmission = await access.register({ principal, actingSubject: actor,
        scope: 'verification:assess:global', action: 'verification.claim.assess',
        idempotencyKey: `assessment-${randomUUID()}`, requestDigest: assessmentDigest });
      const assessmentReceipt = await recordAssessment(environment,
        await access.claim(assessmentAdmission.id, assessmentDigest), assessmentDigest,
      { claim, claimRevision, evidenceSetRevision: evidence.evidence.revision,
        sourceAssessments: [], method: SUPPORT_METHOD, methodRevision: SUPPORT_METHOD,
        policyRevision: SUMMARY_POLICY, evaluationContext: 'urn:context:export-fixture',
        coverage: 'complete', support: 'insufficient', dependence: 'established', independentOrigins: 1,
        scorePerMillion: 800_000, calibration: null,
        limitations: 'This method output has no representative probability calibration.',
        assessorKind: 'automated', actingSubject: actor });
      const assessed = await readAssessment(environment, assessmentReceipt.result.assessment!);
      if (!assessed) throw new Error('Assessment fixture was unavailable');
      await grant(`export:${assessed.assessment}`, 'export.create');
      const app = exportRoutes({ environment, account: account.verifier, access,
        exports: new ExportStore(contentPool), exportVerification: verification } as MainWorkDependencies);
      const body = { profile: 'export-create-v1', actingSubject: actor, useScope: 'evaluation',
        selection: { kind: 'assessment', reference: assessed.assessment,
          expectedPosition: { dataEpoch: assessed.dataEpoch,
            sequence: assessed.sequence } } };
      const response = await app.handle(new Request('http://main.local/v1/exports', {
        method: 'POST', headers: { authorization: `Bearer ${account.tokenA}`,
          'content-type': 'application/json', 'idempotency-key': `export-${randomUUID()}` },
        body: JSON.stringify(body) }));
      expect(response.status, await response.clone().text()).toBe(201);
      const raw = await response.text();
      const saved = JSON.parse(raw) as { manifestId: string; plan: { members: Array<{ sourceGrain: string;
        data: Record<string, unknown> }>; residuals: Array<{ kind: string }> } };
      expect(saved.plan.members.map(item => item.sourceGrain)).toEqual(['claim', 'assessment']);
      expect(saved.plan.members[0]?.data.valueQualifiers).toEqual(['inferred']);
      expect(saved.plan.members[1]?.data.scoreKind).toBe('method-output');
      expect(saved.plan.members[1]?.data.scorePerMillion).toBe(800_000);
      expect(saved.plan.members[1]?.data.calibration).toBeNull();
      expect(saved.plan.residuals.map(item => item.kind)).toEqual(['private_dependency', 'unavailable']);
      expect(raw).not.toContain(privateBody);
      expect(raw).not.toContain(draft.revisionId);
      expect(raw).not.toContain('probability:');
      const reread = await app.handle(new Request(`http://main.local/v1/exports/${saved.manifestId}`, {
        headers: { authorization: `Bearer ${account.tokenA}` },
      }));
      expect(reread.status, await reread.clone().text()).toBe(200);
      expect(await reread.text()).not.toContain(privateBody);
    } finally {
      await account?.close();
      await Promise.all([accessPool.end(), contentPool.end()]);
      await databases.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
