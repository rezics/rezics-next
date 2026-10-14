import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { personaSessions, type PersonaSessions } from '../support/personas.ts';

let sessions: PersonaSessions;
let work: string, structure: string, revision: string, decision: string;
const short = (value: string) => value.slice(-36);
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}
beforeAll(async () => {
  sessions = await personaSessions('private');
  const owner = sessions.owner, actingSubject = owner.actingSubject;
  const created = await answer<{ work: string; mainVersion: string }>(owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title: 'Original recipe without notes', language: 'fr', semanticTypes: ['https://schema.org/Recipe'],
    authoring: 'own-work', actingSubject,
  }, randomUUID()), 201);
  work = created.work;
  const composition = await answer<{ structure: string; revision: string }>(owner.main('POST', '/v1/compositions', {
    profile: 'recipe-composition', work, mainVersion: created.mainVersion, actingSubject,
  }, randomUUID()), 201);
  structure = composition.structure;
  const changed = await answer<{ revision: string }>(owner.main('POST', `/v1/compositions/${short(structure)}/changes`, {
    profile: 'recipe-composition', expectedHead: composition.revision, actingSubject,
    operations: [
      { op: 'insert', parent: structure, position: 'last', role: 'ingredient', qualifier: {
        type: 'ingredient-line', originalText: { value: 'farine', language: 'fr' }, amountLexical: '3/2',
        amount: { numerator: 3, denominator: 2 }, unitText: 'cup', optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'parsed',
      } },
      { op: 'insert', parent: structure, position: 'last', role: 'step', qualifier: {
        type: 'recipe-step', instructionText: { value: 'Mélanger.', language: 'fr' }, usesIngredient: [], media: [], scaling: 'linear',
      } },
    ],
  }, randomUUID()));
  revision = changed.revision;
  const header = await answer<{ revision: string; mainVersion: string; structurePublicationHead: string | null }>(owner.main('GET',
    `/v1/works/${short(work)}?actingSubject=${encodeURIComponent(actingSubject!)}`));
  expect(header.structurePublicationHead).toBeNull();
  const published = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/work-publications', {
    profile: 'work-structure-publication-v1', operation: 'publish', work, actingSubject,
    expectedWorkHead: header.revision, expectedMainVersion: header.mainVersion, structure,
    expectedStructureHead: revision, expectedPublicationHead: header.structurePublicationHead,
    rightsBasis: 'original-contribution', disclosure: 'public',
  }, randomUUID()), 201);
  decision = published.publicationDecision;
}, 180_000);
afterAll(async () => { await sessions?.close(); });

test.each(['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const)(
  '%s reads public structure; only the admitted editor receives the publication compare-and-swap head', async name => {
    const person = sessions[name];
    const query = person.actingSubject ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
    const header = await answer<{ publicationState: string; structurePublicationHead?: string | null }>(person.main('GET', `/v1/works/${short(work)}${query}`));
    expect(header.publicationState).toBe('published');
    if (name === 'owner') expect(header.structurePublicationHead).toBe(decision);
    else expect(Object.hasOwn(header, 'structurePublicationHead')).toBe(false);
    const page = await answer<{ revision: string }>(person.main('GET', `/v1/recipes/works/${short(work)}${query}`));
    expect(page.revision).toBe(revision);
  },
);

test('reopening after withdrawal retains its predecessor instead of proposing a new null head', async () => {
  const owner = sessions.owner;
  const withdrawn = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/work-publications', {
    profile: 'work-structure-publication-v1', operation: 'withdraw', work, actingSubject: owner.actingSubject,
    expectedPublicationHead: decision,
  }, randomUUID()), 201);
  const header = await answer<{ publicationState: string; structurePublicationHead: string }>(owner.main('GET',
    `/v1/works/${short(work)}?actingSubject=${encodeURIComponent(owner.actingSubject!)}`));
  expect(header.publicationState).toBe('unpublished');
  expect(header.structurePublicationHead).toBe(withdrawn.publicationDecision);
});
