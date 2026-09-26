import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { RightsStore } from '../../../services/main/src/modules/rights/store.ts';
import { rightsRoutes } from '../../../services/main/src/routes/rights.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { ratingAccount } from '../support/rating-account.ts';

const agent = () => `https://rezics.com/id/${randomUUID()}`;
const provider = { scopeKind: 'source_provider', provider: 'fixture', namespace: 'rights',
  sourceRecordId: null, contentVariantId: null, mediaAsset: null, component: 'response' };

test('LIVE13-LIVE17: rights evidence stays attached to the exact material and use, with CAS and private reads',
  async () => {
    if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use the QA integration tier');
    const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['account', 'access', 'content']);
    const access = new Pool({ connectionString: databases.urls.access, max: 4 });
    const content = new Pool({ connectionString: databases.urls.content, max: 4 });
    try {
      await migrateContent(content);
      const account = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as
        Record<string, string>, 'openid source:intake');
      const store = new RightsStore(content, access);
      const app = rightsRoutes({ account: account.verifier, rights: { store } } as unknown as MainWorkDependencies);
      const call = async (path: string, token: string, body: object) => {
        const response = await app.handle(new Request(`http://main.local${path}`, { method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
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
      await new ContentCore(content).saveDraft({ operationId: `rights-${randomUUID()}`,
        variant: { id: variant, resourceId: agent(), language: { kind: 'tag', tag: 'en', originalTag: 'en' },
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
      expect((await assess({ ...unknownFact, outcome: 'supported' })).status).toBe(409);
      expect((await evaluate(facts, 'data_rights', 'wiki_display', 'rezics:wiki', account.tokenB)).status).toBe(403);

      // A service-term non-retention result is independent from copyright and source factual entry.
      const retention = await assess({ ...common, material: provider, expressionKind: 'service',
        family: 'service_terms', useKind: 'raw_retention', useScope: 'fixture:api', basis: 'service_terms',
        outcome: 'not_supported', rationale: 'The observed API terms exclude raw response retention.',
        evidence: { termsRevision: 'v1' }, idempotencyKey: 'terms-no-retain' });
      expect(retention.status).toBe(201);
      expect((await evaluate(provider, 'data_rights', 'raw_retention', 'fixture:api')).body.status)
        .toBe('unassessed');

      // NC wiki assessment cannot be inherited by a paid product use.
      const license = 'https://creativecommons.org/licenses/by-nc-sa/4.0/';
      const wiki = await assess({ ...common, material: expression, expressionKind: 'expression',
        useKind: 'wiki_display', basis: 'license', outcome: 'conditional', licenseInstrument: license,
        obligations: [{ kind: 'attribution', instrument: license, appliesTo: 'display', notice: 'Credit source' }],
        idempotencyKey: 'nc-wiki' });
      expect(wiki.status).toBe(201);
      expect((await evaluate(expression, 'data_rights', 'paid_data_product', 'rezics:paid')).body.status)
        .toBe('unassessed');

      // A bounded fair-use quotation retains rationale and extent; a full export has no inherited basis.
      const quote = await assess({ ...common, material: expression, expressionKind: 'expression',
        useKind: 'quotation', useScope: 'rezics:review', basis: 'statutory_exception', outcome: 'conditional',
        exceptionKind: 'fair_use', rationale: 'Twenty words in a review with source attribution.',
        extent: { words: 20 }, evidence: { sourceRevision: 'fixture-r1' }, idempotencyKey: 'quote-20' });
      expect(quote.body).toMatchObject({ exceptionKind: 'fair_use', extent: { words: 20 } });
      expect((await evaluate(expression, 'data_rights', 'export', 'rezics:full')).body.status)
        .toBe('unassessed');

      // A combined export carries its own notices and ShareAlike obligations.
      const exportUse = await assess({ ...common, material: expression, expressionKind: 'expression',
        useKind: 'export', useScope: 'rezics:combined', basis: 'license', outcome: 'conditional',
        licenseInstrument: license, idempotencyKey: 'sa-export', obligations: [
          { kind: 'attribution', instrument: license, appliesTo: 'export', notice: 'Credit source' },
          { kind: 'share_alike', instrument: license, appliesTo: 'redistribution', notice: 'Preserve terms' },
        ] });
      expect(exportUse.status).toBe(201);
      expect((await evaluate(expression, 'data_rights', 'export', 'rezics:combined')).body.assessment.obligations)
        .toHaveLength(2);

      // A race on the same assessment head commits exactly one next revision.
      const revise = (key: string) => assess({ ...common, material: expression, expressionKind: 'expression',
        useKind: 'wiki_display', basis: 'license', outcome: 'conditional', licenseInstrument: license,
        expectedAssessment: wiki.body.assessmentId, idempotencyKey: key });
      const raced = await Promise.all([revise('nc-revise-a'), revise('nc-revise-b')]);
      expect(raced.map(result => result.status).sort()).toEqual([201, 409]);
      expect((await evaluate(expression, 'data_rights', 'wiki_display', 'rezics:wiki')).body.assessment.revision)
        .toBe('2');
      expect((await content.query(`SELECT count(*)::int AS n FROM rights.use_assessment
        WHERE material_id = $1 AND use_kind = 'wiki_display'`, [wiki.body.materialId])).rows[0].n).toBe(2);
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
      }
    } finally {
      await Promise.all([access.end(), content.end()]);
      await databases.close();
    }
  }, 180_000);
