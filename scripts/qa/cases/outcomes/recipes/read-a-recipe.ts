import { randomUUID } from 'node:crypto';
import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('recipes/read-a-recipe', {
  visitor: proved('scales and traverses the published recipe after a private draft without disclosing hidden recipes'),
  stranger: proved('scales and traverses the published recipe after a private draft without disclosing hidden recipes'),
  member: proved('scales and traverses the published recipe after a private draft without disclosing hidden recipes'),
  owner: proved('scales and traverses the published recipe after a private draft with preview on an explicit revision path'),
  moderator: proved('scales and traverses the published recipe after a private draft without moderation widening the read'),
  operator: proved('scales and traverses the published recipe after a private draft without platform authority widening the read'),
}, { rights: { basis: 'original-contribution', credit: 'Original synthetic recipe text and arrangement by the owner Person; native author credit must name that Person.' } });

// Shared public-command fixture builders for the four recipe outcome rows.
export interface RecipePerson {
  actingSubject: string | null;
  main(method: string, path: string, body?: unknown, key?: string): Promise<Response>;
}
export interface RecipeWork {
  work: string;
  workRevision: string;
  mainVersion: string;
  structure: string;
  revision: string;
  draftRevision?: string;
  ingredientTexts: string[];
  occurrenceIds: string[];
}
export const short = (id: string) => id.slice(-36);
export const acting = (person: RecipePerson) => person.actingSubject
  ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
export async function fixtureAnswer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  if (response.status !== status) throw new Error(`Recipe setup expected HTTP ${status}, got ${response.status}: ${raw}`);
  return JSON.parse(raw) as T;
}

export function ingredient(parent: string, text: string) {
  return { op: 'insert', parent, position: 'last', role: 'ingredient', qualifier: {
    type: 'ingredient-line', originalText: { value: text, language: 'en' },
    amountLexical: '1 1/2', amount: { numerator: 3, denominator: 2 },
    unitText: 'cup', optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'parsed',
  } };
}

export async function originalRecipe(person: RecipePerson, title: string,
  options: { published?: boolean; paged?: boolean; laterDraft?: boolean; language?: string; type?: string } = {}): Promise<RecipeWork> {
  const actor = person.actingSubject;
  const work = await fixtureAnswer<{ work: string; workRevision: string; mainVersion: string }>(
    person.main('POST', '/v1/works', { profile: 'metadata-only-v1', title,
      language: options.language ?? 'en', semanticTypes: [options.type ?? 'https://schema.org/Recipe'],
      authoring: 'own-work', actingSubject: actor }), 201);
  const created = await fixtureAnswer<{ structure: string; revision: string }>(person.main('POST',
    '/v1/compositions', { profile: 'recipe-composition', work: work.work,
      mainVersion: work.mainVersion, actingSubject: actor }), 201);
  let revision = created.revision;
  const occurrenceIds: string[] = [];
  const change = async (operations: object[]) => {
    const ids: string[] = [];
    for (let index = 0; index < operations.length; index += 16) {
      const result = await fixtureAnswer<{ revision: string; occurrences: string[] }>(person.main('POST',
        `/v1/compositions/${short(created.structure)}/changes`, { profile: 'recipe-composition',
          expectedHead: revision, actingSubject: actor, operations: operations.slice(index, index + 16) }));
      revision = result.revision;
      ids.push(...result.occurrences);
    }
    occurrenceIds.push(...ids);
    return ids;
  };
  const [group] = await change([{ op: 'insert', parent: created.structure, position: 'last',
    role: 'group', label: { value: 'Sauce', language: 'en' } }]);
  const ingredientTexts = ['1 1/2 cups tomato', '1 1/2 cups salt'];
  await change(ingredientTexts.map(text => ingredient(group!, text)));
  if (options.paged) {
    const flour = Array.from({ length: 100 }, (_, index) => `1 1/2 cups flour ${index}`);
    ingredientTexts.push(...flour);
    await change(flour.map(text => ingredient(created.structure, text)));
  }
  await change([{ op: 'insert', parent: created.structure, position: 'last', role: 'group',
    label: { value: 'Empty garnish', language: 'en' } },
  ...['Mix the sauce.', 'Cook for five minutes.'].map(text => ({ op: 'insert',
    parent: created.structure, position: 'last', role: 'step', qualifier: { type: 'recipe-step',
      instructionText: { value: text, language: 'en' }, usesIngredient: [], media: [], scaling: 'linear' } }))]);
  const measured = await fixtureAnswer<{ revision: string }>(person.main('POST',
    `/v1/recipes/${short(created.structure)}/measures`, { expectedHead: revision, actingSubject: actor,
      yield: { value: { numerator: 4, denominator: 1 }, unitText: 'servings', coverage: 'complete', provenance: 'declared' },
      servings: { value: { numerator: 4, denominator: 1 }, coverage: 'complete', provenance: 'declared' },
      nutrition: { basis: 'whole-recipe', inputs: [] } }));
  revision = measured.revision;
  if (options.published !== false) await fixtureAnswer(person.main('POST', '/v1/work-publications', {
    profile: 'work-structure-publication-v1', operation: 'publish', work: work.work,
    actingSubject: actor, expectedWorkHead: work.workRevision, expectedMainVersion: work.mainVersion,
    structure: created.structure, expectedStructureHead: revision, expectedPublicationHead: null,
    disclosure: 'public', rightsBasis: 'original-contribution',
  }), 201);
  const result: RecipeWork = { ...work, structure: created.structure, revision, ingredientTexts, occurrenceIds: [...occurrenceIds] };
  if (options.laterDraft) {
    await change([ingredient(created.structure, 'PRIVATE DRAFT parsley')]);
    result.draftRevision = revision;
  }
  return result;
}

export async function recipeCatalogue(sessions: { owner: RecipePerson; realm: string }, phrase: string) {
  const owner = sessions.owner, actor = owner.actingSubject;
  const root = `/v1/realms/${short(sessions.realm)}`, roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: 'Recipe catalogue editors', permissions: ['publication.adopt'] },
    { kind: 'assignment', roleId, member: actor, assigned: true, validUntil: new Date(Date.now() + 3_600_000).toISOString() },
  ]) {
    const roles = await fixtureAnswer<{ generation: string }>(owner.main('GET', `${root}/roles?${acting(owner)}`));
    const command = { actingSubject: actor, expectedGeneration: roles.generation,
      reason: 'Publish the original recipe outcome catalogue', change };
    const preview = await fixtureAnswer<{ digest: string }>(owner.main('POST', `${root}/role-impact`, command));
    await fixtureAnswer(owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: preview.digest }), 201);
  }
  const matching: string[] = [];
  const excluded: string[] = [];
  for (let index = 0; index < 24; index++) {
    const language = index === 21 ? 'it' : 'en';
    const work = await fixtureAnswer<{ work: string; mainVersion: string }>(owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: `${phrase} ${index}`, language, authoring: 'own-work',
      semanticTypes: [index === 22 ? 'https://schema.org/Book' : 'https://schema.org/Recipe'], actingSubject: actor,
    }), 201);
    if (index < 21) matching.push(work.work); else excluded.push(work.work);
    if (index === 23) continue;
    const draft = await fixtureAnswer<{ contribution: string; draftRevision: string }>(owner.main('POST',
      '/v1/contributions', { profile: 'text-contribution-v1', work: work.work, language,
        body: `Original recipe ${index}: mix the sauce, then cook for five minutes.`, actingSubject: actor }), 201);
    const publication = await fixtureAnswer<{ publicationDecision: string }>(owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
    }), 201);
    const selection = { work: work.work, contribution: draft.contribution,
      publicationDecision: publication.publicationDecision, expectedSelectionHead: null, actingSubject: actor };
    await fixtureAnswer(owner.main('POST', '/v1/publication-selections', { ...selection,
      profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
      selectionBasis: 'main-maintainer' }), 201);
    await fixtureAnswer(owner.main('POST', '/v1/publication-selections', { ...selection,
      profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: sessions.realm },
      mainVersion: work.mainVersion, selectionBasis: 'realm-manager-review' }), 201);
  }
  return { matching, excluded };
}
