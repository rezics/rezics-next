import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { planExport, type VerifiedExportMember } from '../../../services/main/src/modules/export/planner.ts';
import { RightsStore, resourceFactMaterial, rightsExportUseScope, workDescriptionMaterial,
  type MaterialScope } from '../../../services/main/src/modules/rights/store.ts';
import { startMediaStack } from './media-support.ts';

function countQueries(pool: Pool, match: (sql: string) => boolean) {
  const original = pool.query.bind(pool);
  let matched = 0;
  pool.query = ((...args: unknown[]) => {
    if (match(String(args[0]))) matched++;
    return (original as (...values: unknown[]) => unknown)(...args);
  }) as typeof pool.query;
  return { count: () => matched, restore: () => { pool.query = original; } };
}

test('public reads return wiki-display obligations, an unassessed head, and nothing from a hidden material', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use the QA integration tier');
  const stack = await startMediaStack('rights-obligation-read');
  try {
    const author = await stack.member('rights-reader');
    await author.grant('rights:assess', 'rights.assess');
    const licensed = await stack.publicWork(author.actor, ['en'], 'Licensed description');
    const plain = await stack.publicWork(author.actor, ['en'], 'Unassessed description');
    const hidden = await stack.publicWork(author.actor, ['en'], 'Hidden description');
    const openLibrary = 'https://creativecommons.org/licenses/by/4.0/';
    const vndb = 'https://creativecommons.org/licenses/by-sa/4.0/';
    const assess = async (material: MaterialScope, expressionKind: 'expression' | 'fact', useKind: string,
      useScope: string, obligations: object[], key: string, instrument: string | null = openLibrary) => {
      const response = await author.send('POST', '/v1/rights/use-assessments', {
        profile: 'rights-use-assessment-v1', actingSubject: author.actor, material, expressionKind,
        family: 'data_rights', useKind, useScope, basis: 'license', outcome: 'conditional',
        licenseInstrument: instrument, exceptionKind: null, rationale: null, extent: {}, evidence: {},
        obligations, expectedAssessment: null, idempotencyKey: key,
      }, key);
      const text = await response.text();
      expect(response.status, text).toBe(201);
      return JSON.parse(text) as { assessmentId: string };
    };
    const wiki = await assess(workDescriptionMaterial(licensed.work), 'expression', 'wiki_display', 'rezics:wiki', [
      { kind: 'attribution', instrument: openLibrary, appliesTo: 'display', notice: 'Open Library, https://openlibrary.org/works/OL45804W' },
      { kind: 'share_alike', instrument: openLibrary, appliesTo: 'export', notice: 'export only' },
      { kind: 'change_indication', instrument: openLibrary, appliesTo: 'all', notice: 'Name the change' },
    ], 'open-library-wiki');
    const facts = await assess(resourceFactMaterial(licensed.work), 'fact', 'wiki_display', 'rezics:wiki', [
      { kind: 'attribution', instrument: vndb, appliesTo: 'display', notice: 'VNDB, https://vndb.org/v17' },
    ], 'vndb-facts', vndb);
    const secret = 'Hidden source notice must not leak';
    await assess(workDescriptionMaterial(hidden.work), 'expression', 'wiki_display', 'rezics:wiki', [
      { kind: 'attribution', instrument: 'https://example.test/hidden-license', appliesTo: 'display', notice: secret },
    ], 'hidden-wiki', 'https://example.test/hidden-license');

    const headerSql = countQueries(stack.contentPool, sql => sql.includes('-- wiki-display obligations'));
    const headerFence = countQueries(stack.accessPool, sql => sql.includes('-- wiki-display disclosure'));
    stack.fuseki.queries = 0;
    const licensedHeader = await stack.call('GET', `/v1/works/${licensed.work.slice(-36)}`);
    const licensedBody = await licensedHeader.json() as { descriptionObligations: { status: string; instrument?: string;
      obligations?: Array<{ kind: string; appliesTo: string; notice: string | null }> } };
    const licensedGraph = stack.fuseki.queries;
    expect(licensedHeader.status, JSON.stringify(licensedBody)).toBe(200);
    expect(licensedBody.descriptionObligations).toEqual({ status: 'assessed', use: 'wiki_display', instrument: openLibrary,
      obligations: [
        { kind: 'attribution', instrument: openLibrary, appliesTo: 'display', notice: 'Open Library, https://openlibrary.org/works/OL45804W' },
        { kind: 'change_indication', instrument: openLibrary, appliesTo: 'all', notice: 'Name the change' },
      ] });
    expect(headerSql.count()).toBe(2);
    expect(headerFence.count()).toBe(2);
    headerSql.restore();
    headerFence.restore();

    stack.fuseki.queries = 0;
    const plainHeader = await stack.call('GET', `/v1/works/${plain.work.slice(-36)}`);
    const plainBody = await plainHeader.json() as { descriptionObligations: unknown;
      cover: { kind: string; coverCredit?: unknown } };
    expect(plainHeader.status).toBe(200);
    expect(plainBody.descriptionObligations).toEqual({ status: 'unassessed' });
    expect(plainBody.cover.kind).toBe('fallback');
    expect(plainBody.cover).not.toHaveProperty('coverCredit');
    expect(stack.fuseki.queries).toBe(licensedGraph);

    const caseId = randomUUID(), decisionId = randomUUID(), fenceId = randomUUID();
    await stack.accessPool.query(`INSERT INTO access.scope_gate (id) VALUES ('governance:platform') ON CONFLICT DO NOTHING`);
    await stack.accessPool.query(`INSERT INTO access.governance_case
      (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
      VALUES ($1,'content_report','platform','governance:platform','urn:rezics:context:global','graph',$2,'synopsis','private')`,
    [caseId, hidden.work]);
    await stack.accessPool.query(`INSERT INTO access.moderation_decision
      (id,kind,outcome,context,case_id,case_sequence,principal_id,acting_subject,authority_kind,authority_scope_id,
      authority_epoch,authority_proof_digest,idempotency_key,request_digest,rule_ref,rule_revision,rule_digest,evidence_digest,disclosure,statement_of_reasons)
      VALUES ($1::uuid,'content_moderation','restrict','urn:rezics:context:global',$2,1,$3,$4,'platform','governance:platform',
      0,$5,$1::text,$5,'urn:rezics:rule:obligation-read','1',$5,$5,'private',$6::jsonb)`,
    [decisionId, caseId, author.principalId, author.actor, 'b'.repeat(64), {
      facts: 'The synopsis mark stays off the public read.', scope: 'synopsis',
      duration: 'Until an attributable restoration.', automation: false,
      appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en',
      rule: { ref: 'urn:rezics:rule:obligation-read', revision: '1', digest: 'b'.repeat(64) },
    }]);
    await stack.accessPool.query(`INSERT INTO access.moderation_decision_target
      (decision_id,ordinal,owner,resource,component,scope_kind,effect)
      VALUES ($1,1,'graph',$2,'synopsis','component','disclosure')`, [decisionId, hidden.work]);
    await stack.accessPool.query(`INSERT INTO access.governance_enforcement
      (id,authority_scope_id,context,owner,resource,component,revision,effect,decision_id,decision_ordinal,state,fence_epoch)
      VALUES ($1,'governance:platform','urn:rezics:context:global','graph',$2,'synopsis',NULL,'disclosure',$3,1,'restricted',1)`,
    [fenceId, hidden.work, decisionId]);
    const hiddenHeader = await stack.call('GET', `/v1/works/${hidden.work.slice(-36)}`);
    const hiddenText = await hiddenHeader.text();
    expect(hiddenHeader.status, hiddenText).toBe(200);
    const hiddenBody = JSON.parse(hiddenText) as { descriptionObligations: unknown;
      cover: { kind: string; coverCredit?: unknown } };
    expect(hiddenBody.descriptionObligations).toEqual({ status: 'unassessed' });
    expect(hiddenBody.cover.kind).toBe('fallback');
    expect(hiddenBody.cover).not.toHaveProperty('coverCredit');
    expect(hiddenText).not.toContain(secret);
    expect(hiddenText).not.toContain('hidden-license');

    const caughtUp = async (work: string) => {
      for (let turn = 0; turn < 8; turn++) {
        const response = await stack.call('GET', `/v1/resources/${work.slice(-36)}/statements`);
        if (response.status === 200) { await response.arrayBuffer(); return; }
        await response.arrayBuffer();
        await stack.statementSeek.projectWithPublication();
      }
    };
    await caughtUp(licensed.work);
    const statementSql = countQueries(stack.contentPool, sql => sql.includes('-- wiki-display obligations'));
    const statementPage = await stack.call('GET', `/v1/resources/${licensed.work.slice(-36)}/statements`);
    const statementBody = await statementPage.json() as { factObligations: unknown };
    expect(statementPage.status, JSON.stringify(statementBody)).toBe(200);
    expect(statementBody.factObligations).toEqual({ status: 'assessed', use: 'wiki_display', instrument: vndb,
      obligations: [{ kind: 'attribution', instrument: vndb, appliesTo: 'display', notice: 'VNDB, https://vndb.org/v17' }] });
    expect(statementSql.count()).toBe(1);
    statementSql.restore();
    await caughtUp(plain.work);
    const plainStatements = await stack.call('GET', `/v1/resources/${plain.work.slice(-36)}/statements`);
    expect((await plainStatements.json() as { factObligations: unknown }).factObligations).toEqual({ status: 'unassessed' });

    const store = new RightsStore(stack.contentPool, stack.accessPool);
    const exportMember = (material: MaterialScope): VerifiedExportMember => ({
      sourceOwner: 'graph', sourceNamespace: 'fixture:rights', sourceGrain: 'work', exactRef: licensed.work,
      contentRevisionId: null, refDigest: 'c'.repeat(64), ownerDataEpoch: '1', ownerSequence: '1',
      sourcePosition: null, targetGrain: 'work', mapping: 'exact',
      data: { rightsIdentity: { material, target: null } },
    });
    const beforeExport = await store.exportScope([exportMember(workDescriptionMaterial(licensed.work))], 'full');
    expect(beforeExport[0]).toMatchObject({ basisKind: 'unassessed', result: 'undetermined', obligations: [], basisRef: null });
    const exported = await assess(workDescriptionMaterial(licensed.work), 'expression', 'export',
      rightsExportUseScope('full'), [
        { kind: 'attribution', instrument: openLibrary, appliesTo: 'export', notice: 'Credit the export' },
        { kind: 'change_indication', instrument: openLibrary, appliesTo: 'all', notice: 'Mark the export change' },
      ], 'open-library-export');
    const afterExport = await planExport({ targetProfile: 'rezics-content-v1', useScope: 'full',
      members: [exportMember(workDescriptionMaterial(licensed.work))], residuals: [] }, store.exportScope);
    expect(afterExport.bases[0]).toMatchObject({ basisKind: 'use_assessment', basisRef: exported.assessmentId,
      obligations: ['attribution', 'change_indication'], result: 'conditional' });
    expect(afterExport.bases[0]?.basisRef).not.toBe(wiki.assessmentId);
    expect(facts.assessmentId).not.toBe(wiki.assessmentId);
  } finally {
    await stack.stop();
  }
}, 300_000);
