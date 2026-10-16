import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { resourceFactMaterial } from '../../../services/main/src/modules/rights/store.ts';
import { personaSessions, type PersonaSessions } from '../support/personas.ts';
import { document, paragraph } from '../../../scripts/qa/cases/outcomes/recipes/instructions-in-any-form.ts';

setDefaultTimeout(180_000);
let sessions: PersonaSessions;
beforeAll(async () => { sessions = await personaSessions('public'); });
afterAll(async () => { await sessions?.close(); });
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
}
const short = (id: string) => id.slice(-36);

test('a sourced section list publishes exact attribution and adopted Content through shared owners', async () => {
  const operator = sessions.operator, actor = operator.actingSubject!;
  const listing = () => answer<{ authorityEpoch: string; items: Array<{ permission: string;
    active: boolean; recipient: { principalId?: string } }> }>(operator.main('GET',
    `/v1/access/grants?profile=platform-grants-v1&issuerSubject=${encodeURIComponent(actor)}`));
  const principalId = (await listing()).items.find(item => item.permission === 'platform:grant' && item.active)!.recipient.principalId!;
  const mandate = async (permission: string, scopeId?: string) => {
    const grantId = randomUUID();
    const result = await answer<{ grant: { id: string; generation: string } }>(operator.main('POST', '/v1/access/grant-changes', {
      profile: 'platform-grant-change-v1', action: 'create', issuerSubject: actor,
      expectedAuthorityEpoch: (await listing()).authorityEpoch, grantId, permission,
      ...(scopeId ? { scopeId } : {}), recipient: { principalId }, validUntil: null,
    }));
    return result.grant;
  };
  const revoke = async (grant: { id: string; generation: string }) => answer(operator.main('POST', '/v1/access/grant-changes', {
    profile: 'platform-grant-change-v1', action: 'revoke', issuerSubject: actor,
    expectedAuthorityEpoch: (await listing()).authorityEpoch, grantId: grant.id, expectedObjectGeneration: grant.generation,
  }));
  await mandate('platform:use:catalogue-import');
  await mandate('platform:resource:work.create', 'work:create:root');
  const ownWork = (title: string) => answer<{ work: string; workRevision: string; mainVersion: string }>(operator.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title, language: 'en', semanticTypes: ['https://schema.org/Book'],
    authoring: 'own-work', actingSubject: actor,
  }), 201);
  const notebook = await ownWork('Independent notes');
  const book = await answer<{ structure: string; revision: string }>(operator.main('POST', '/v1/compositions', {
    profile: 'book-composition', work: notebook.work, mainVersion: notebook.mainVersion, actingSubject: actor,
  }), 201);
  const post = await answer<{ post: string; variantId: string }>(operator.main('POST', `/v1/works/${short(notebook.work)}/chapters`, {
    profile: 'book-chapter-create-v1', title: 'Editorial note', language: 'en', direction: 'ltr',
    parent: book.structure, position: 'last', expectedCompositionHead: book.revision, actingSubject: actor,
  }));
  const content = await answer<{ revisionId: string }>(operator.main('POST', '/v1/content-drafts', {
    profile: 'content-text-v1', resourceId: post.post, variantId: post.variantId,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', expectedHead: null,
    document: document([paragraph('note', 'An original editorial note.')]), actingSubject: actor,
  }), 201);
  const selector = { grain: 'content', variantId: post.variantId, revision: content.revisionId };
  const work = await ownWork('Public-domain section list');
  const structure = await answer<{ structure: string; revision: string }>(operator.main('POST', '/v1/compositions', {
    profile: 'section-list-v1', work: work.work, mainVersion: work.mainVersion, actingSubject: actor,
  }), 201);
  const sourceDocument = { url: 'https://example.org/public-domain/list', author: null,
    license: 'https://creativecommons.org/publicdomain/zero/1.0/',
    items: [
      { role: 'section', parent: null, labels: [{ value: 'First section', language: 'en' }] },
      { role: 'entry', parent: 0, labels: [], target: post.post,
        qualifier: { type: 'fields', id: 'entry', values: { note: 'Editorial commentary' } },
        selection: { mode: 'fixed-revision', revision: content.revisionId, selector } },
    ] };
  const retain = async (value: unknown, basis = 'public-domain') =>
    (await answer<{ observation: { observation: string; record: string } }>(operator.main('POST', '/v1/sources/intakes', {
      profile: 'source-manual-intake-v1', provider: 'independent-archive', namespace: 'section-list',
      externalId: randomUUID(), sourceRevision: 'exact-cut', mediaType: 'application/json', retention: 'retained',
      rawBytesBase64: Buffer.from(JSON.stringify(value)).toString('base64'),
      coverage: { scope: 'complete-section-list', complete: true, omittedFields: [] },
      rightsEvidence: { basis, note: 'Synthetic public-domain list fixture; no clearance claim.' },
    }), 201)).observation;
  const source = await retain(sourceDocument);
  const changed = await answer<{ revision: string; occurrences: string[] }>(operator.main('POST',
    `/v1/compositions/${short(structure.structure)}/changes`, { profile: 'section-list-v1',
      expectedHead: structure.revision, actingSubject: actor,
      operations: [{ op: 'insert', parent: structure.structure, role: 'section', position: 'last',
        sourceKey: `${source.observation}#/items/0`, label: sourceDocument.items[0]!.labels[0] }],
    }));
  const complete = await answer<{ revision: string }>(operator.main('POST',
    `/v1/compositions/${short(structure.structure)}/changes`, { profile: 'section-list-v1',
      expectedHead: changed.revision, actingSubject: actor,
      operations: [{ op: 'insert', parent: changed.occurrences[0], role: 'entry', position: 'last', target: post.post,
        sourceKey: `${source.observation}#/items/1`, qualifier: { note: 'Editorial commentary' },
        selection: { mode: 'fixed-revision', revision: content.revisionId, selector } }],
    }));
  const publication = { profile: 'work-structure-publication-v1', operation: 'publish', work: work.work,
    actingSubject: actor, expectedWorkHead: work.workRevision, expectedMainVersion: work.mainVersion,
    structure: structure.structure, expectedStructureHead: complete.revision, expectedPublicationHead: null,
    disclosure: 'public', rightsBasis: 'public-domain', sourceObservation: source.observation };
  await answer(sessions.visitor.main('GET', `/v1/works/${short(work.work)}`), 404);
  await answer(operator.main('POST', '/v1/work-publications', publication), 403);
  const wrong = await mandate('platform:resource:work.publish', `work:publish:${notebook.work}`);
  await answer(operator.main('POST', '/v1/work-publications', publication), 403);
  await revoke(wrong);
  const grant = await mandate('platform:resource:work.publish', `work:publish:${work.work}`);
  const unrelated = await retain({ ...sourceDocument, items: [...sourceDocument.items].reverse() });
  await answer(operator.main('POST', '/v1/work-publications', { ...publication,
    sourceObservation: unrelated.observation }), 404);
  const unassessed = await retain(sourceDocument, 'unknown');
  await answer(operator.main('POST', '/v1/work-publications', { ...publication,
    sourceObservation: unassessed.observation }), 404);
  await answer(sessions.visitor.main('GET', `/v1/content-revisions/${content.revisionId}`), 404);
  const key = randomUUID();
  const published = await answer<{ publicationDecision: string }>(operator.main('POST', '/v1/work-publications', publication, key), 201);
  expect(await answer(operator.main('POST', '/v1/work-publications', publication, key)))
    .toMatchObject({ ...published, replayed: true });
  await revoke(grant);
  const header = await answer<{ rights: unknown }>(sessions.visitor.main('GET', `/v1/works/${short(work.work)}`));
  expect(header.rights).toMatchObject({ basis: 'public-domain', source: { record: source.record, observation: source.observation,
    provider: 'independent-archive', url: sourceDocument.url, author: null, transcriber: actor } });
  const credits = await answer<{ items: Array<{ role: string; displayName: string | null; agent: string | null }> }>(
    sessions.visitor.main('GET', `/v1/works/${short(work.work)}/credits`));
  expect(credits.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'author', displayName: null, agent: null }),
    expect.objectContaining({ role: 'transcriber', agent: actor }),
  ]));
  // Draft successors never move either the selected Structure or its Content pin.
  await answer(operator.main('POST', '/v1/content-drafts', {
    profile: 'content-text-v1', resourceId: post.post, variantId: post.variantId,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', expectedHead: content.revisionId,
    document: document([paragraph('note', 'PRIVATE successor note.')]), actingSubject: actor,
  }), 201).then(async value => {
    const successor = value as { revisionId: string };
    await answer(sessions.visitor.main('GET', `/v1/content-revisions/${successor.revisionId}`), 404);
  });
  const delivered = await answer<{ body: { document: unknown } }>(sessions.visitor.main('GET', `/v1/content-revisions/${content.revisionId}`));
  expect(JSON.stringify(delivered)).toContain('An original editorial note.');
  expect(JSON.stringify(delivered)).not.toContain('PRIVATE successor');
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN');
    await grantFixtureAuthority(client, { scope: 'rights:assess', requireDispatch: true,
      representations: [{ principalId, actor, action: 'rights.assess', lifetime: '8 hours' }],
      grant: { actor, action: 'rights.assess', lifetime: '8 hours' } });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await accessPool.end(); }
  const assess = (outcome: 'supported' | 'not_supported', expectedAssessment: string | null) => {
    const idempotencyKey = randomUUID();
    return answer<{ assessmentId: string }>(operator.main('POST', '/v1/rights/use-assessments', {
      profile: 'rights-use-assessment-v1', actingSubject: actor, material: resourceFactMaterial(work.work),
      expressionKind: 'compilation', family: 'data_rights', useKind: 'wiki_display', useScope: 'rezics:wiki',
      basis: 'public_domain', outcome, expectedAssessment, licenseInstrument: null, exceptionKind: null,
      rationale: null, extent: {}, evidence: { sourceUrl: sourceDocument.url }, obligations: [], idempotencyKey,
    }, idempotencyKey), 201);
  };
  const denied = await assess('not_supported', null);
  await answer(sessions.visitor.main('GET', `/v1/content-revisions/${content.revisionId}`), 404);
  await assess('supported', denied.assessmentId);
  await answer(sessions.visitor.main('GET', `/v1/content-revisions/${content.revisionId}`));
  await answer(operator.main('POST', '/v1/work-publications', { profile: 'work-structure-publication-v1', operation: 'withdraw',
    work: work.work, actingSubject: actor, expectedPublicationHead: published.publicationDecision }), 201);
  await answer(sessions.visitor.main('GET', `/v1/content-revisions/${content.revisionId}`), 404);
});
