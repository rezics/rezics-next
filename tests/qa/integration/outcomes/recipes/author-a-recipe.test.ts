import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import authoring from '../../../../../scripts/qa/cases/outcomes/recipes/author-a-recipe.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(authoring);
type Recipe = { work: string; mainVersion: string; structure: string; revision: string; workHead: string; publicationDecision: string; groups: string[]; lines: string[] };
let recipe: Recipe;
let draft: string;
const short = (id: string) => id.slice(-36);
const query = (person: PersonaSession) => person.actingSubject
  ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
const publication = (recipe: Recipe, person: PersonaSession) => ({
  profile: 'work-structure-publication-v1', operation: 'publish', work: recipe.work,
  actingSubject: person.actingSubject, expectedWorkHead: recipe.workHead, expectedMainVersion: recipe.mainVersion,
  structure: recipe.structure, expectedStructureHead: recipe.revision,
  expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
});
async function authored(person: PersonaSession, sample: ReturnType<typeof recording.session> = (_label, ...args) => person.main(...args)): Promise<Recipe> {
  const work = await answer<{ work: string; mainVersion: string }>(sample('create-work', 'POST', '/v1/works', {
    profile: 'metadata-only-v1', title: 'Original two-stage flour recipe', language: 'en',
    semanticTypes: ['https://schema.org/Recipe'], authoring: 'own-work', actingSubject: person.actingSubject,
  }), 201);
  const created = await answer<{ structure: string; revision: string }>(sample('create-composition', 'POST', '/v1/compositions', {
    profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: person.actingSubject,
  }), 201);
  const path = `/v1/compositions/${short(created.structure)}`;
  const groups = await answer<{ revision: string; occurrences: string[] }>(sample('create-groups', 'POST', `${path}/changes`, {
    profile: 'recipe-composition', expectedHead: created.revision, actingSubject: person.actingSubject,
    operations: ['Mix', 'Finish'].map(value => ({ op: 'insert', parent: created.structure, position: 'last', role: 'group', label: { value, language: 'en' } })),
  }));
  const changed = await answer<{ revision: string; occurrences: string[] }>(sample('create-ingredients-and-steps', 'POST', `${path}/changes`, {
    profile: 'recipe-composition', expectedHead: groups.revision, actingSubject: person.actingSubject,
    operations: [
      ...[{ numerator: 3, denominator: 2 }, { numerator: 1, denominator: 4 }].map((amount, index) => ({
        op: 'insert', parent: groups.occurrences[index], position: 'last', role: 'ingredient',
        qualifier: { type: 'ingredient-line', originalText: { value: 'flour', language: 'en' },
          amountLexical: `${amount.numerator}/${amount.denominator}`, amount, unitText: 'cup', optional: false,
          scaling: 'linear', substituteFor: [], parseStatus: 'parsed' },
      })),
      { op: 'insert', parent: groups.occurrences[0], position: 'last', role: 'step',
        qualifier: { type: 'recipe-step', instructionText: { value: 'Mix the first flour portion.', language: 'en' }, usesIngredient: [], media: [], scaling: 'linear' } },
      { op: 'insert', parent: groups.occurrences[1], position: 'last', role: 'step',
        qualifier: { type: 'recipe-step', instructionText: { value: 'Fold in the second flour portion.', language: 'en' }, usesIngredient: [], media: [], scaling: 'linear' } },
    ],
  }));
  const head = await answer<{ revision: string }>(sample('work-head', 'GET', `/v1/works/${short(work.work)}/scalar-value${query(person)}`));
  const candidate: Recipe = { ...work, structure: created.structure, revision: changed.revision,
    groups: groups.occurrences, lines: changed.occurrences.slice(0, 2), workHead: head.revision, publicationDecision: '' };
  const published = await answer<{ publicationDecision: string }>(sample('publish-recipe', 'POST', '/v1/work-publications', publication(candidate, person)), 201);
  return { ...candidate, publicationDecision: published.publicationDecision };
}
beforeAll(async () => {
  sessions = await personaSessions('private');
  await recording.prepare();
  recipe = await authored(sessions.owner);
  draft = (await answer<{ revision: string }>(sessions.owner.main('POST', `/v1/compositions/${short(recipe.structure)}/changes`, {
    profile: 'recipe-composition', actingSubject: sessions.owner.actingSubject, expectedHead: recipe.revision,
    operations: [{ op: 'insert', parent: recipe.structure, position: 'last', role: 'step',
      qualifier: { type: 'recipe-step', instructionText: { value: 'Private draft note.', language: 'en' }, usesIngredient: [], media: [], scaling: 'linear' } }],
  }))).revision;
}, 180_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { await sessions?.close(); }
});

async function readPublished(person: PersonaSession, value: Recipe, author: PersonaSession, name: PersonaName, prefix: string) {
  // The author's authenticated page is a private preview; public readers follow the publication pin.
  const reader = person === author ? sessions.visitor : person;
  const sample = recording.session(name, reader);
  type Occurrence = { occurrence: string; role: string; parent: string; qualifier?: { instructionText?: { value: string } } };
  const page = await answer<{ revision: string; occurrences: Occurrence[]; ingredients: { originalText: string; amount: { numerator: number; denominator: number } }[] }>(sample(`${prefix}-recipe`, 'GET', `/v1/recipes/works/${short(value.work)}${query(reader)}`));
  if (page.revision !== value.revision) console.info('Recipe publication pin mismatch', {
    request: `GET /v1/recipes/works/${short(value.work)}${query(reader)}`,
    status: 200, publishedRevision: value.revision, actualRevision: page.revision,
    instructions: page.occurrences.filter(item => item.role === 'step').map(item => item.qualifier?.instructionText?.value),
  });
  expect(page.revision).toBe(value.revision);
  expect(page.ingredients.map(item => item.originalText)).toEqual(['flour', 'flour']);
  expect(page.ingredients.map(item => item.amount)).toEqual([{ numerator: 3, denominator: 2 }, { numerator: 1, denominator: 4 }]);
  expect(page.occurrences.filter(item => item.role === 'ingredient').map(item => item.occurrence)).toEqual(value.lines);
  expect(page.occurrences.filter(item => item.role === 'step').map(item => item.qualifier?.instructionText?.value)).toEqual(['Mix the first flour portion.', 'Fold in the second flour portion.']);
  const credits = await answer<{ items: { role: string; agent: string }[] }>(sample(`${prefix}-credits`, 'GET', `/v1/works/${short(value.work)}/credits${query(reader)}`));
  expect(credits.items.filter(item => item.role === 'author').map(item => item.agent)).toEqual([author.actingSubject!]);
  for (const [index, group] of value.groups.entries()) {
    const parameters = new URLSearchParams({ parent: group,
      ...(reader.actingSubject ? { actingSubject: reader.actingSubject } : {}) });
    const composition = await answer<{ revision: string; occurrences: { parent: string }[] }>(sample(`${prefix}-group-${index}`, 'GET', `/v1/compositions/${short(value.structure)}?${parameters}`));
    expect(composition.revision).toBe(value.revision);
    expect(composition.occurrences).toHaveLength(2);
    expect(composition.occurrences.every(item => item.parent === group)).toBe(true);
  }
}
async function author(name: PersonaName) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  await editorReads(name, recipe.work);
  const path = `/v1/compositions/${short(recipe.structure)}`;
  if (name === 'owner') {
    await readPublished(person, recipe, sessions.owner, name, 'published');
    expect(await answer(sample('private-draft', 'GET', `${path}${query(person)}`))).toMatchObject({ revision: draft });
    const command = { actingSubject: person.actingSubject, expectedHead: draft, restoredFrom: recipe.revision };
    const key = randomUUID();
    const restored = await answer<{ revision: string }>(sample('restore-draft', 'POST', `${path}/restorations`, command, key));
    expect(await answer(sample('restore-replay', 'POST', `${path}/restorations`, command, key))).toMatchObject({ revision: restored.revision, replayed: true });
    await answer(sample('restore-stale', 'POST', `${path}/restorations`, command), 409);
    await readPublished(sessions.visitor, recipe, person, name, 'published-after-restoration');
    draft = (await answer<{ revision: string }>(sample('new-private-draft', 'POST', `${path}/changes`, {
      profile: 'recipe-composition', actingSubject: person.actingSubject, expectedHead: restored.revision,
      operations: [{ op: 'insert', parent: recipe.structure, position: 'last', role: 'step',
        qualifier: { type: 'recipe-step', instructionText: { value: 'Private draft note.', language: 'en' }, usesIngredient: [], media: [], scaling: 'linear' } }],
    }))).revision;
    return;
  }
  const denialActor = name === 'visitor' ? sessions.owner : person;
  await answer(sample('peer-edit-denied', 'POST', `${path}/changes`, {
    profile: 'recipe-composition', actingSubject: denialActor.actingSubject, expectedHead: draft,
    operations: [{ op: 'remove', occurrence: recipe.lines[0] }],
  }), name === 'visitor' ? 401 : 403);
  await answer(sample('peer-publication-denied', 'POST', '/v1/work-publications', {
    ...publication(recipe, denialActor), expectedStructureHead: draft, expectedPublicationHead: recipe.publicationDecision,
  }), name === 'visitor' ? 401 : 403);
  if (name === 'stranger' || name === 'member') {
    const own = await authored(person, sample);
    await readPublished(sessions.visitor, own, person, name, 'own-published');
    const scaled = await answer<{ ingredients: { amount: { numerator: number; denominator: number } }[] }>(sample('scaled-ingredients', 'POST', `/v1/recipes/${short(own.structure)}/scalings`, {
      actingSubject: person.actingSubject, factor: { numerator: 2, denominator: 3 },
    }));
    expect(scaled.ingredients.map(item => item.amount)).toEqual([{ numerator: 1, denominator: 1 }, { numerator: 1, denominator: 6 }]);
  }
  await readPublished(person, recipe, sessions.owner, name, 'published');
  const hidden = await sample('draft-concealed', 'GET', `${path}/revisions/${short(draft)}${query(person)}`);
  const absent = await sample('draft-absent', 'GET', `${path}/revisions/${randomUUID()}${query(person)}`);
  expect(hidden.status).toBe(404);
  expect([hidden.status, await hidden.text()]).toEqual([absent.status, await absent.text()]);
}
// RecipeEditPage opens authority and the header for everyone, then draft details for the author.
async function editorReads(name: PersonaName, work: string) {
  const person = sessions[name], sample = recording.session(name, person);
  const id = short(work);
  await answer(sample('editor-authority', 'GET', `/v1/resources/${id}/page${query(person)}`));
  await answer(sample('editor-work-header', 'GET', `/v1/works/${id}${query(person)}`));
  if (name !== 'owner') return;
  await answer(sample('editor-resource-summary', 'GET', `/v1/resources/${id}${query(person)}`));
  await answer(sample('editor-metadata-empty', 'GET', `/v1/works/${id}/metadata${query(person)}`));
  await answer(sample('editor-recipe-draft', 'GET', `/v1/recipes/works/${id}${query(person)}`));
  await answer(sample('editor-notes-empty', 'GET', `/v1/me/contributions${query(person)}&limit=20`));
}

outcomeTest(authoring, 'visitor', () => author('visitor'), recording);
outcomeTest(authoring, 'stranger', () => author('stranger'), recording);
outcomeTest(authoring, 'member', () => author('member'), recording);
outcomeTest(authoring, 'owner', () => author('owner'), recording);
outcomeTest(authoring, 'moderator', () => author('moderator'), recording);
outcomeTest(authoring, 'operator', () => author('operator'), recording);
