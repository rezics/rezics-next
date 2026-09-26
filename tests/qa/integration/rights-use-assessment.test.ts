import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { SourceIntakeInvalid, SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { SourceRunInvalid, SourceRunStore, type CaptureRequest,
  type SourceRunProviderAdapter } from '../../../services/main/src/modules/source/acquisition-run.ts';
import { RightsInvalid, RightsStore, rightsExportUseScope, sourceRetentionScope,
  type AssessmentInput, type MaterialScope } from '../../../services/main/src/modules/rights/store.ts';
import { planExport, type VerifiedExportMember } from '../../../services/main/src/modules/export/planner.ts';
import { rightsRoutes } from '../../../services/main/src/routes/rights.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { ratingAccount } from '../support/rating-account.ts';

const agent = () => `https://rezics.com/id/${randomUUID()}`;
const provider = { scopeKind: 'source_provider', provider: 'open-library', namespace: 'work',
  sourceRecordId: null, contentVariantId: null, mediaAsset: null, component: 'response' };

test('LIVE13/LIVE14/LIVE15/LIVE16/LIVE17: unknown rights, scoped reassessment, retention limits and export obligations stay exact',
  async () => {
    if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use the QA integration tier');
    const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['account', 'access', 'content']);
    const access = new Pool({ connectionString: databases.urls.access, max: 4 });
    const content = new Pool({ connectionString: databases.urls.content, max: 4 });
    try {
      await migrateContent(content);
      const account = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as
        Record<string, string>, 'openid rights:assess');
      const store = new RightsStore(content, access);
      const app = rightsRoutes({ account: account.verifier, rights: { store } } as unknown as MainWorkDependencies);
      const call = async (path: string, token: string, body: object) => {
        const response = await app.handle(new Request(`http://main.local${path}`, { method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
            ...('idempotencyKey' in body ? { 'idempotency-key': String(body.idempotencyKey) } : {}) },
          body: JSON.stringify(body) }));
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
      };
      const actor = agent();
      const principal = randomUUID();
      await access.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1, $2, $3)`, [principal, account.issuer, account.a.id]);
      await access.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`, [actor]);
      await access.query(`INSERT INTO access.scope_gate (id) VALUES ('rights:assess') ON CONFLICT DO NOTHING`);
      await access.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, 'rights.assess', now() + interval '1 hour')`,
      [randomUUID(), principal, actor]);

      const variant = `urn:rezics:variant:${randomUUID()}`;
      const resource = agent();
      const factDraft = await new ContentCore(content).saveDraft({ operationId: `rights-${randomUUID()}`,
        variant: { id: variant, resourceId: resource, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
          direction: 'ltr' }, expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
        provenance: { fixture: 'rights' }, serializedJson: JSON.stringify({ facts: ['one'] }) });
      const facts = { scopeKind: 'content_variant', provider: null, namespace: null, sourceRecordId: null,
        contentVariantId: variant, mediaAsset: null, component: 'facts' };
      const expression = { ...facts, component: 'synopsis' };
      const common = { profile: 'rights-use-assessment-v1', actingSubject: actor,
        family: 'data_rights', useScope: 'rezics:wiki', outcome: 'undetermined',
        licenseInstrument: null, exceptionKind: null, rationale: null, extent: {}, evidence: {},
        obligations: [], expectedAssessment: null };
      const assess = (body: object, token = account.tokenA) => call('/v1/rights/use-assessments', token, body);
      const evaluate = (material: object, family: string, useKind: string, useScope: string,
        token = account.tokenA) => call('/v1/rights/use-evaluations', token,
        { profile: 'rights-use-evaluation-v1', actingSubject: actor, material, family, useKind, useScope });

      // An Account bearer without the current Access grant cannot author or read private rights evidence.
      const unknownFact = { ...common, material: facts, expressionKind: 'fact', useKind: 'wiki_display',
        basis: 'unknown', idempotencyKey: 'fact-unknown' };
      expect((await assess(unknownFact)).status).toBe(403);
      await access.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id,
        action, valid_until) VALUES ($1, $2, $2, 'rights:assess', 'rights.assess', now() + interval '1 hour')`,
      [randomUUID(), actor]);
      const recorded = await assess(unknownFact);
      expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
      expect(recorded.body).toMatchObject({ basis: 'unknown', outcome: 'undetermined', expressionKind: 'fact',
        revision: '1' });
      expect((await assess(unknownFact)).body).toMatchObject({ assessmentId: recorded.body.assessmentId,
        replayed: true });
      const falseFactBasis: AssessmentInput = { ...common, material: expression as MaterialScope,
        expressionKind: 'expression', useKind: 'wiki_display', basis: 'unprotected_fact', outcome: 'supported',
        idempotencyKey: 'false-factual-basis' };
      await expect(store.assess({ issuer: account.issuer, subject: account.a.id }, falseFactBasis))
        .rejects.toBeInstanceOf(RightsInvalid);
      expect((await assess({ ...unknownFact, outcome: 'supported' })).status).toBe(409);
      expect((await evaluate(facts, 'data_rights', 'wiki_display', 'rezics:wiki', account.tokenB)).status).toBe(403);
      const unknownExpression = await assess({ ...common, material: expression, expressionKind: 'expression',
        useKind: 'wiki_display', basis: 'unknown', idempotencyKey: 'synopsis-unknown' });
      expect(unknownExpression.status).toBe(201);
      expect(unknownExpression.body).toMatchObject({ basis: 'unknown', outcome: 'undetermined',
        expressionKind: 'expression', licenseInstrument: null });
      expect(factDraft.revisionId).toBeTruthy();

      // A service-term non-retention result is independent from copyright and source factual entry.
      const retentionScope = sourceRetentionScope(provider.provider!, provider.namespace!);
      const retention = await assess({ ...common, material: provider, expressionKind: 'service',
        family: 'service_terms', useKind: 'raw_retention', useScope: retentionScope, basis: 'service_terms',
        outcome: 'not_supported', rationale: 'The observed API terms exclude raw response retention.',
        evidence: { termsRevision: 'v1' }, idempotencyKey: 'terms-no-retain' });
      expect(retention.status, JSON.stringify(retention.body)).toBe(201);
      expect((await evaluate(provider, 'service_terms', 'raw_retention', retentionScope)).body)
        .toMatchObject({ status: 'assessed', assessment: { outcome: 'not_supported', basis: 'service_terms' } });
      expect((await evaluate(provider, 'data_rights', 'raw_retention', retentionScope)).body.status).toBe('unassessed');
      const intakePrincipal = randomUUID();
      let providerRequests = 0;
      const runs = new SourceRunStore(content, { reserve: async () => {}, fetcher: async () => {
        providerRequests++;
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      }, rawRetentionPermitted: (sourceProvider, namespace) =>
        store.rawRetentionPermitted(sourceProvider, namespace) });
      const runKey = 'prohibited-source-run';
      await expect(runs.runOpenLibraryWorks(intakePrincipal, runKey, { profile: 'open-library-works-run-v1',
        workIds: ['OL123W'], editions: false, ratings: false, frontier: false })).rejects.toBeInstanceOf(SourceRunInvalid);
      expect(providerRequests).toBe(0);
      expect((await content.query(`SELECT count(*)::int AS n FROM source.acquisition_run
        WHERE principal_id = $1 AND idempotency_key = $2`, [intakePrincipal, runKey])).rows[0].n).toBe(0);
      const editionsProvider = { ...provider, namespace: 'work-editions' };
      const editionsScope = sourceRetentionScope(editionsProvider.provider!, editionsProvider.namespace!);
      const allowedTerms = await assess({ ...common, material: editionsProvider, expressionKind: 'service',
        family: 'service_terms', useKind: 'raw_retention', useScope: editionsScope, basis: 'service_terms',
        outcome: 'supported', rationale: 'The assessed provider terms allow temporary raw capture.',
        idempotencyKey: 'terms-allow-editions' });
      expect(allowedTerms.status).toBe(201);
      const started = await runs.start(intakePrincipal, 'resume-after-terms-change', 'open-library',
        'rights-run-replay-v1', 'a'.repeat(64), [{ surface: 'editions', namespace: 'work-editions',
          required: true, captureLimit: 1 }], 'https://openlibrary.org/developers/api');
      let capturedRequests = 0;
      const captureRequest: CaptureRequest = { requestKey: 'GET /editions/OL123W.json',
        path: '/editions/OL123W.json', namespace: 'work-editions', externalId: 'OL123W',
        coverageScope: 'rights-run-fixture-v1', captureProfile: 'rights-run-fixture-v1',
        validate: value => value && typeof value === 'object' ? null : 'malformed' };
      const adapter: SourceRunProviderAdapter = { provider: 'open-library',
        termsReference: 'https://openlibrary.org/developers/api', fetch: async () => {
          capturedRequests++;
          const bytes = Buffer.from('{"edition":1}');
          return { ok: true, url: 'https://openlibrary.org/editions/OL123W.json', status: 200,
            mediaType: 'application/json', bytes, parsed: { edition: 1 }, etag: null, lastModified: null,
            fetchedAt: new Date().toISOString() };
        }, decode: bytes => JSON.parse(bytes.toString('utf8')) };
      expect(await runs.acquire(intakePrincipal, started.runId, 'editions', captureRequest, adapter))
        .toMatchObject({ ok: true, parsed: { edition: 1 } });
      const prohibitEdits = await assess({ ...common, material: editionsProvider, expressionKind: 'service',
        family: 'service_terms', useKind: 'raw_retention', useScope: editionsScope, basis: 'service_terms',
        outcome: 'not_supported', rationale: 'The provider terms now exclude retained raw captures.',
        expectedAssessment: allowedTerms.body.assessmentId, idempotencyKey: 'terms-prohibit-editions' });
      expect(prohibitEdits.status).toBe(201);
      expect(await runs.acquire(intakePrincipal, started.runId, 'editions', captureRequest, adapter))
        .toMatchObject({ ok: false, outcome: 'unqualified', reason: 'retention-prohibited' });
      expect(capturedRequests).toBe(1);
      const intake = new SourceIntakeStore(content);
      intake.setRawRetentionGate((sourceProvider, namespace) => store.rawRetentionPermitted(sourceProvider, namespace));
      const intakeBytes = Buffer.from(JSON.stringify({ facts: ['independent fact'] })).toString('base64');
      const sourceInput = { provider: provider.provider!, namespace: provider.namespace!, externalId: 'no-retain',
        sourceRevision: 'r1', mediaType: 'application/json' as const, retention: 'retained' as const,
        rawBytesBase64: intakeBytes, coverage: { scope: 'source-record', complete: true, omittedFields: [] },
        rightsEvidence: { basis: 'unknown' as const, note: 'Copyright basis has not been assessed.' } };
      await expect(intake.submit(intakePrincipal, 'prohibited-raw-capture', sourceInput))
        .rejects.toBeInstanceOf(SourceIntakeInvalid);
      const nonRetained = await intake.submit(intakePrincipal, 'non-retained-observation', {
        ...sourceInput, externalId: 'no-retain-metadata', retention: 'not-retained', rawBytesBase64: undefined });
      expect(nonRetained.observation).toMatchObject({ retention: 'not-retained', byteLength: null, byteDigest: null });
      expect(nonRetained.observation.rawBytesBase64).toBeUndefined();
      const independent = await intake.submit(intakePrincipal, 'independent-provider-capture', {
        ...sourceInput, provider: 'another-provider', externalId: 'independent-route' });
      expect(independent.observation).toMatchObject({ retention: 'retained', byteLength: Buffer.from(intakeBytes, 'base64').length });
      expect(await store.rawRetentionPermitted('another-provider', provider.namespace!)).toBe(true);
      const independentFacts = await assess({ ...common,
        material: { scopeKind: 'source_record', provider: null, namespace: null,
          sourceRecordId: independent.observation.record.split('/').at(-1)!, contentVariantId: null,
          mediaAsset: null, component: 'fact' },
        expressionKind: 'fact', useKind: 'wiki_display', useScope: 'rezics:wiki:independent',
        basis: 'unprotected_fact', outcome: 'supported', idempotencyKey: 'independent-route-fact' });
      expect(independentFacts.status).toBe(201);
      expect((await evaluate({ scopeKind: 'source_record', provider: null, namespace: null,
        sourceRecordId: independent.observation.record.split('/').at(-1)!, contentVariantId: null,
        mediaAsset: null, component: 'fact' }, 'data_rights', 'wiki_display', 'rezics:wiki:independent')).body)
        .toMatchObject({ status: 'assessed', assessment: { outcome: 'supported', basis: 'unprotected_fact' } });

      // NC wiki assessment cannot be inherited by a paid product use.
      const license = 'https://creativecommons.org/licenses/by-nc-sa/4.0/';
      const wiki = await assess({ ...common, material: expression, expressionKind: 'expression',
        useKind: 'wiki_display', basis: 'license', outcome: 'conditional', licenseInstrument: license,
        obligations: [{ kind: 'attribution', instrument: license, appliesTo: 'display', notice: 'Credit source' }],
        expectedAssessment: unknownExpression.body.assessmentId, idempotencyKey: 'nc-wiki' });
      expect(wiki.status).toBe(201);
      expect((await evaluate(expression, 'data_rights', 'paid_data_product', 'rezics:paid')).body.status)
        .toBe('unassessed');
      const paid = await assess({ ...common, material: expression, expressionKind: 'expression',
        useKind: 'paid_data_product', useScope: 'rezics:paid', basis: 'license', outcome: 'not_supported',
        licenseInstrument: license, idempotencyKey: 'nc-paid' });
      expect(paid.status).toBe(201);
      expect(paid.body).toMatchObject({ assessmentId: expect.any(String), predecessor: null, useScope: 'rezics:paid',
        outcome: 'not_supported' });
      expect((await evaluate(expression, 'data_rights', 'wiki_display', 'rezics:wiki')).body.assessment)
        .toMatchObject({ assessmentId: wiki.body.assessmentId, outcome: 'conditional' });
      expect((await evaluate(expression, 'data_rights', 'paid_data_product', 'rezics:paid')).body.assessment)
        .toMatchObject({ assessmentId: paid.body.assessmentId, outcome: 'not_supported' });

      // A bounded fair-use quotation retains rationale and extent; a full export has no inherited basis.
      const quote = await assess({ ...common, material: expression, expressionKind: 'expression',
        useKind: 'quotation', useScope: 'rezics:review', basis: 'statutory_exception', outcome: 'conditional',
        exceptionKind: 'fair_use', rationale: 'Twenty words in a review with source attribution.',
        extent: { words: 20 }, evidence: { sourceRevision: 'fixture-r1' }, idempotencyKey: 'quote-20' });
      expect(quote.body).toMatchObject({ exceptionKind: 'fair_use', extent: { words: 20 },
        rationale: 'Twenty words in a review with source attribution.', licenseInstrument: null });
      expect((await evaluate(expression, 'data_rights', 'quotation', 'rezics:review')).body.assessment)
        .toMatchObject({ assessmentId: quote.body.assessmentId, exceptionKind: 'fair_use', extent: { words: 20 } });
      expect((await evaluate(expression, 'data_rights', 'export', 'rezics:full')).body.status)
        .toBe('unassessed');

      // A combined export carries its own notices and ShareAlike obligations.
      const exportUse = await assess({ ...common, material: expression, expressionKind: 'expression',
        useKind: 'export', useScope: rightsExportUseScope('full'), basis: 'license', outcome: 'conditional',
        licenseInstrument: license, idempotencyKey: 'sa-export', obligations: [
          { kind: 'attribution', instrument: license, appliesTo: 'export', notice: 'Credit source' },
          { kind: 'share_alike', instrument: license, appliesTo: 'redistribution', notice: 'Preserve terms' },
        ] });
      expect(exportUse.status).toBe(201);
      const factExport = await assess({ ...common, material: facts, expressionKind: 'fact', useKind: 'export',
        useScope: rightsExportUseScope('full'), basis: 'unprotected_fact', outcome: 'supported',
        idempotencyKey: 'facts-full-export' });
      expect(factExport.status).toBe(201);
      const rightsIdentity = (material: object, materialId: string, component: string): Record<string, unknown> => ({
        materialId, material, target: component === 'facts' ? null
          : { owner: 'content', resource, component, revision: factDraft.revisionId },
      });
      const exportMember = (component: string, material: object, materialId: string): VerifiedExportMember => ({
        sourceOwner: 'content', sourceNamespace: 'fixture:rights', sourceGrain: 'content_revision',
        exactRef: factDraft.revisionId!, contentRevisionId: factDraft.revisionId!, refDigest: 'a'.repeat(64),
        ownerDataEpoch: 'fixture-epoch', ownerSequence: '1', sourcePosition: null,
        targetGrain: 'content-body', mapping: 'exact',
        data: { rightsIdentity: rightsIdentity(material, materialId, component) },
      });
      const combined = await planExport({ targetProfile: 'rezics-content-v1', useScope: 'full',
        members: [exportMember('synopsis', expression, exportUse.body.materialId),
          exportMember('facts', facts, factExport.body.materialId)], residuals: [] }, store.exportScope);
      expect(combined).toMatchObject({ licenseScope: 'determined', licenseExpression: license });
      expect(combined.bases).toMatchObject([
        { basisKind: 'use_assessment', basisRef: exportUse.body.assessmentId,
          obligations: ['attribution', 'share_alike'], memberOrdinals: [1] },
        { basisKind: 'unprotected_fact', basisRef: factExport.body.assessmentId, memberOrdinals: [2] },
      ]);
      expect((await evaluate(expression, 'data_rights', 'export', rightsExportUseScope('full'))).body.assessment.obligations)
        .toHaveLength(2);

      // A race on the same assessment head commits exactly one next revision.
      const revise = (key: string) => assess({ ...common, material: expression, expressionKind: 'expression',
        useKind: 'wiki_display', basis: 'license', outcome: 'conditional', licenseInstrument: license,
        expectedAssessment: wiki.body.assessmentId, idempotencyKey: key });
      const raced = await Promise.all([revise('nc-revise-a'), revise('nc-revise-b')]);
      expect(raced.map(result => result.status).sort()).toEqual([201, 409]);
      expect((await evaluate(expression, 'data_rights', 'wiki_display', 'rezics:wiki')).body.assessment.revision)
        .toBe('3');
      expect((await content.query(`SELECT count(*)::int AS n FROM rights.use_assessment
        WHERE material_id = $1 AND use_kind = 'wiki_display'`, [wiki.body.materialId])).rows[0].n).toBe(3);
      await expect(content.query('DELETE FROM rights.use_assessment WHERE id = $1', [wiki.body.assessmentId]))
        .rejects.toThrow('immutable');

      // Exact use-key reads stay index-bounded as unrelated materials grow.
      for (const total of [100, 1_000, 10_000]) {
        await content.query(`INSERT INTO rights.material (id, scope_kind, provider, namespace, component,
          expression_kind) SELECT gen_random_uuid(), 'source_provider', 'fixture',
          'unrelated-' || g::text, 'response', 'service'
          FROM generate_series((SELECT count(*)::int FROM rights.material), $1::int - 1) g`, [total]);
        await content.query('ANALYZE rights.material');
        const plan = (await content.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
          SELECT id FROM rights.material WHERE scope_kind = 'content_variant' AND provider IS NOT DISTINCT FROM NULL
            AND namespace IS NOT DISTINCT FROM NULL AND source_record_id IS NOT DISTINCT FROM NULL
            AND content_variant_id = $1 AND media_asset IS NOT DISTINCT FROM NULL AND component = 'synopsis'`,
        [variant])).rows[0]['QUERY PLAN'][0].Plan;
        expect(plan['Actual Rows']).toBe(1);
        expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(20);
        expect(plan['Temp Read Blocks']).toBe(0);
        const retentionPlan = (await content.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
          SELECT a.outcome FROM rights.material m
          JOIN rights.use_assessment_head h ON h.material_id = m.id AND h.family = 'service_terms'
            AND h.use_kind = 'raw_retention' AND h.use_scope = $3
          JOIN rights.use_assessment a ON a.id = h.assessment_id
          WHERE m.scope_kind = 'source_provider' AND m.provider = $1 AND m.namespace = $2
            AND m.component = 'response' LIMIT 2`,
        [provider.provider, provider.namespace, retentionScope])).rows[0]['QUERY PLAN'][0].Plan;
        expect(retentionPlan['Actual Rows']).toBe(1);
        expect(retentionPlan['Shared Hit Blocks'] + retentionPlan['Shared Read Blocks']).toBeLessThan(20);
        expect(retentionPlan['Temp Read Blocks']).toBe(0);
      }
    } finally {
      await Promise.all([access.end(), content.end()]);
      await databases.close();
    }
  }, 180_000);
