import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { personaSessions, type PersonaSession } from '../support/personas.ts';
import type { ContentDerivationRecord } from '../../../services/content/src/derivation.ts';
import type { ResourceReference } from '../../../services/content/src/adoption.ts';

const short = (id: string) => id.slice(-36);
async function answer<T>(response: Promise<Response>, status: number): Promise<T> {
  const result = await response, text = await result.text();
  expect(result.status, `${result.status}: ${text}`).toBe(status); return JSON.parse(text) as T;
}
const actorQuery = (person: PersonaSession) => person.actingSubject ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';

test('Content APIs author Posts through chapters, validate procedures, pin derivation inputs and conceal private source revisions', async () => {
  const sessions = await personaSessions('public');
  try {
    const owner = sessions.owner, actingSubject = owner.actingSubject!;
    const book = await answer<{ work: string; mainVersion: string }>(owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: 'Content procedure notebook', language: 'en',
      semanticTypes: ['https://schema.org/Book'], authoring: 'own-work', actingSubject,
    }), 201);
    const composition = await answer<{ structure: string; revision: string }>(owner.main('POST', '/v1/compositions', {
      profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject,
    }), 201);
    const chapterBody = { profile: 'book-chapter-create-v1', title: 'Exact derived procedure', language: 'en',
      direction: 'ltr', parent: composition.structure, position: 'last', expectedCompositionHead: composition.revision, actingSubject };
    const chapterKey = randomUUID(), path = `/v1/works/${short(book.work)}/chapters`;
    const post = await answer<{ post: string; variantId: string }>(owner.main('POST', path, chapterBody, chapterKey), 200);
    expect(await answer(owner.main('POST', path, chapterBody, chapterKey), 200)).toMatchObject({ ...post, replayed: true });
    const draftFields = { profile: 'content-text-v1', resourceId: post.post, variantId: post.variantId,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject };
    const sourceDocument = structuredClone(fromPlainText('PRIVATE original source instruction', 'blocks'));
    sourceDocument.doc.content![0]!.attrs!.id = 'source';
    const source = await answer<{ revisionId: string }>(owner.main('POST', '/v1/content-drafts', {
      ...draftFields, expectedHead: null, document: sourceDocument,
    }), 201);
    const procedure = { version: 'rezics-document-v1', profile: 'blocks', doc: { type: 'doc', content: [{ type: 'extensionBlock',
      attrs: { id: 'procedure', definition: 'https://rezics.com/definition/procedure-v1', version: '1',
        fallback: 'Stir the stock.', payload: { items: [{ id: 'step', type: 'HowToStep', document: fromPlainText('Stir the stock.', 'blocks') }] } } }] } };
    const output = await answer<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(owner.main('POST', '/v1/content-drafts', {
      ...draftFields, expectedHead: source.revisionId, document: procedure,
    }), 201);
    const exactPath = `/v1/content-revisions/${output.revisionId}`;
    const before = await answer(owner.main('GET', `${exactPath}${actorQuery(owner)}`), 200);
    const ai = await answer<{ agent: string }>(owner.main('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'service', displayName: 'Content procedure transformer',
    }), 201);
    const outputRef = { target: post.post, selector: { grain: 'content', variantId: post.variantId, revision: output.revisionId, block: 'procedure' } };
    const input: ResourceReference = { target: post.post,
      selector: { grain: 'content', variantId: post.variantId, revision: source.revisionId, block: 'source', span: { start: 0, end: 7 } } };
    const command = { profile: 'content-derivation-v1', output: outputRef, inputs: [input],
      activity: { kind: 'transformation' }, responsibleAgent: ai.agent, expectedOutputHead: output.revisionId, actingSubject };
    const key = randomUUID();
    const derivation = await answer<ContentDerivationRecord>(owner.main('POST', '/v1/content-derivations', command, key), 201);
    expect(derivation.responsibleAgentType).toBe('software'); expect(derivation.inputs).toEqual([input]);
    expect(await answer(owner.main('POST', '/v1/content-derivations', command, key), 200)).toMatchObject({ ...derivation, replayed: true });
    expect(await answer(owner.main('GET', `${exactPath}${actorQuery(owner)}`), 200)).toEqual(before);
    expect((await sessions.stranger.main('POST', '/v1/content-derivations', { ...command,
      actingSubject: sessions.stranger.actingSubject })).status).toBe(403);
    expect((await owner.main('POST', '/v1/content-derivations', { ...command, responsibleAgent: sessions.stranger.actingSubject })).status).toBe(403);
    expect((await owner.main('POST', '/v1/content-derivations', { ...command,
      inputs: [{ target: post.post, selector: { grain: 'resource' } }] })).status).toBe(400);
    expect((await owner.main('POST', '/v1/content-derivations', { ...command, output: { ...outputRef,
      selector: { ...outputRef.selector, block: 'missing' } } })).status).toBe(400);
    const published = await answer<{ decision: string }>(owner.main('POST', '/v1/content-publications', {
      profile: 'content-publication-v1', resourceId: post.post, variantId: post.variantId,
      revisionId: output.revisionId, preparationId: randomUUID(), expectedDigest: output.byteDigest,
      expectedContentEpoch: output.sourcePosition.dataEpoch, expectedPublicationHead: null, actingSubject,
    }), 201);
    await answer(owner.main('POST', '/v1/content-search-eligibility', {
      profile: 'content-search-eligibility-v1', resourceId: post.post, variantId: post.variantId,
      publicationDecision: published.decision, expectedEligibilityHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject,
    }), 201);
    const successor = await answer<{ revisionId: string }>(owner.main('POST', '/v1/content-drafts', {
      ...draftFields, expectedHead: output.revisionId, body: 'PRIVATE successor procedure',
    }), 201);
    expect((await owner.main('POST', '/v1/content-derivations', command)).status).toBe(409);
    const visitor = sessions.visitor;
    const hiddenHistory = await visitor.main('GET', `/v1/content-revisions/${successor.revisionId}/derivations`);
    const absentHistory = await visitor.main('GET', `/v1/content-revisions/${randomUUID()}/derivations`);
    expect(hiddenHistory.status).toBe(404); expect(absentHistory.status).toBe(404);
    expect(await hiddenHistory.json()).toEqual(await absentHistory.json());
    expect((await visitor.main('GET', `/v1/content-revisions/${successor.revisionId}`)).status).toBe(404);
    expect(await answer(visitor.main('GET', exactPath), 200)).toEqual(before);
    const publicHistory = await answer<{ items: { inputs: unknown[] }[] }>(visitor.main('GET', `${exactPath}/derivations`), 200);
    expect(publicHistory.items[0]!.inputs).toEqual([{ status: 'unavailable' }]);
    expect(JSON.stringify(publicHistory)).not.toContain(source.revisionId);
    expect(JSON.stringify(publicHistory)).not.toContain('principal');
    const publicResolution = await answer<{ items: { status: string; document?: unknown }[] }>(visitor.main('POST', '/v1/resource-reference-resolutions', {
      references: [outputRef, input, { ...outputRef, selector: { ...outputRef.selector, revision: successor.revisionId } }],
    }), 200);
    expect(publicResolution.items.map(item => item.status)).toEqual(['available', 'unavailable', 'unavailable']);
    expect(publicResolution.items[0]!.document).toMatchObject({ doc: { content: [{ type: 'extensionBlock', attrs: { id: 'procedure' } }] } });
  } finally { await sessions.close(); }
}, 240_000);
