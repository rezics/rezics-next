import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import exchange from '../../../../../scripts/qa/cases/outcomes/recipes/exchange-recipes.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(180_000);
const destinations = new Map<PersonaName, { prefix: string; recipe: Recipe }[]>();
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(exchange);
type Recipe = { work: string; mainVersion: string; structure: string; revision: string; workHead: string };
type Export = { revision: string; recipe: { recipeIngredient: Record<string, unknown>[]; recipeInstructions: unknown[] }; sourceObservations: string[]; residuals: unknown[] };
let source: Recipe;
let retained: Recipe & { observation: string };
let sourceExport: Export;
const short = (id: string) => id.slice(-36);
const query = (person: PersonaSession) => person.actingSubject
  ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
const exportPath = (recipe: Recipe, person: PersonaSession) => `/v1/recipes/${short(recipe.structure)}/exports/schema-org${query(person)}&revision=${encodeURIComponent(recipe.revision)}`;
const importPath = (recipe: Recipe, person: PersonaSession) => `/v1/recipes/${short(recipe.structure)}/file-imports${query(person)}&expectedHead=${encodeURIComponent(recipe.revision)}`;
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
async function destination(person: PersonaSession, sample?: ReturnType<typeof recording.session>, prefix = 'destination'): Promise<Recipe> {
  const request: ReturnType<typeof recording.session> = sample ?? ((_label, ...args) => person.main(...args));
  const work = await answer<{ work: string; mainVersion: string }>(request(`${prefix}-work`, 'POST', '/v1/works', {
    profile: 'metadata-only-v1', title: 'Original recipe exchange fixture', language: 'en',
    semanticTypes: ['https://schema.org/Recipe'], authoring: 'own-work', actingSubject: person.actingSubject,
  }), 201);
  const structure = await answer<{ structure: string; revision: string }>(request(`${prefix}-composition`, 'POST', '/v1/compositions', {
    profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: person.actingSubject,
  }), 201);
  const head = await answer<{ revision: string }>(request(`${prefix}-work-head`, 'GET', `/v1/works/${short(work.work)}/scalar-value${query(person)}`));
  return { ...work, ...structure, workHead: head.revision };
}
const publish = (recipe: Recipe, person: PersonaSession) => ({
  profile: 'work-structure-publication-v1', operation: 'publish', work: recipe.work,
  actingSubject: person.actingSubject, expectedWorkHead: recipe.workHead, expectedMainVersion: recipe.mainVersion,
  structure: recipe.structure, expectedStructureHead: recipe.revision, expectedPublicationHead: null,
  rightsBasis: 'original-contribution', disclosure: 'public',
});
beforeAll(async () => {
  sessions = await personaSessions('private');
  await recording.prepare();
  const owner = sessions.owner;
  source = await destination(owner);
  const path = `/v1/compositions/${short(source.structure)}/changes`;
  const groups = await answer<{ revision: string; occurrences: string[] }>(owner.main('POST', path, {
    profile: 'recipe-composition', expectedHead: source.revision, actingSubject: owner.actingSubject,
    operations: ['Mix', 'Finish'].map(value => ({ op: 'insert', parent: source.structure, position: 'last', role: 'group', label: { value, language: 'en' } })),
  }));
  const changed = await answer<{ revision: string }>(owner.main('POST', path, {
    profile: 'recipe-composition', expectedHead: groups.revision, actingSubject: owner.actingSubject,
    operations: [
      ...[{ numerator: 3, denominator: 2 }, { numerator: 1, denominator: 4 }].map(amount => ({
        op: 'insert', parent: source.structure, position: 'last', role: 'ingredient',
        qualifier: { type: 'ingredient-line', originalText: { value: 'flour', language: 'fr' }, amountLexical: `${amount.numerator}/${amount.denominator}`,
          amount, unitText: 'cup', optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'partial' },
      })),
      ...['Mix the first portion.', 'Fold in the second portion.'].map((value, index) => ({
        op: 'insert', parent: groups.occurrences[index], position: 'last', role: 'step',
        qualifier: { type: 'recipe-step', instructionText: { value, language: 'en' }, usesIngredient: [], media: [], scaling: 'linear' },
      })),
    ],
  }));
  source.revision = changed.revision;
  await answer(owner.main('POST', '/v1/work-publications', publish(source, owner)), 201);
  sourceExport = await answer(owner.main('GET', exportPath(source, owner)));
  retained = { ...await destination(owner), observation: '' };
  const imported = await answer<{ revision: string; sourceObservation: string }>(owner.main('POST', importPath(retained, owner), sourceExport.recipe), 201);
  retained.revision = imported.revision;
  retained.observation = imported.sourceObservation;
}, 180_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { await sessions?.close(); }
});

async function exchangeRecipe(name: PersonaName) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  const publicPage = await answer<{ revision: string; ingredients: { originalText: string }[] }>(sample('public-recipe', 'GET', `/v1/recipes/works/${short(source.work)}${query(person)}`));
  expect(publicPage.revision).toBe(source.revision);
  expect(publicPage.ingredients.map(item => item.originalText)).toEqual(['flour', 'flour']);
  const credits = await answer<{ items: { role: string; agent: string }[] }>(sample('public-credits', 'GET', `/v1/works/${short(source.work)}/credits${query(person)}`));
  expect(credits.items.filter(item => item.role === 'author').map(item => item.agent)).toEqual([sessions.owner.actingSubject!]);
  if (name === 'visitor') {
    await answer(sample('export-authentication-required', 'GET', exportPath(source, sessions.owner)), 401);
    await answer(sample('file-import-authentication-required', 'POST', importPath(source, sessions.owner), sourceExport.recipe), 401);
    await answer(sample('observation-import-authentication-required', 'POST', `/v1/recipes/${short(source.structure)}/imports`, {
      actingSubject: sessions.owner.actingSubject, expectedHead: source.revision, sourceObservation: retained.observation,
    }), 401);
    return;
  }
  const exported = await answer<Export>(sample('schema-org-export', 'GET', exportPath(source, person)));
  expect(exported.revision).toBe(source.revision);
  expect(exported.recipe).toEqual(sourceExport.recipe);
  expect(exported.recipe.recipeIngredient.map(item => item.value)).toEqual(['3/2', '1/4']);
  expect(exported.recipe.recipeIngredient.map(item => item.inLanguage)).toEqual(['fr', 'fr']);
  expect(exported.residuals).toHaveLength(2);
  if (name !== 'owner') {
    await answer(sample('peer-file-import-denied', 'POST', importPath(source, person), exported.recipe), 403);
    const observationRequest = { actingSubject: person.actingSubject, expectedHead: source.revision, sourceObservation: retained.observation };
    const hidden = await sample('observation-import-concealed', 'POST', `/v1/recipes/${short(source.structure)}/imports`, observationRequest);
    const absent = await sample('observation-import-absent', 'POST', `/v1/recipes/${short(source.structure)}/imports`, { ...observationRequest, sourceObservation: `https://rezics.com/id/${randomUUID()}` });
    expect(hidden.status).toBe(404);
    expect([hidden.status, await hidden.text()]).toEqual([absent.status, await absent.text()]);
  }
  if (name === 'moderator' || name === 'operator') return;
  const own = await destination(person, sample, 'file-destination');
  destinations.set(name, [{ prefix: 'file-destination', recipe: own }]);
  await answer(sample('recipe-empty', 'GET', `/v1/recipes/works/${short(own.work)}${query(person)}`));
  const key = randomUUID();
  const imported = await answer<{ revision: string; sourceObservation: string; replayed: boolean }>(sample('file-import', 'POST', importPath(own, person), exported.recipe, key), 201);
  expect(imported.replayed).toBe(false);
  expect(await answer(sample('file-import-replay', 'POST', importPath(own, person), exported.recipe, key), 200))
    .toMatchObject({ ...imported, replayed: true });
  await answer(sample('file-import-stale', 'POST', importPath(own, person), exported.recipe), 409);
  const importedRecipe = { ...own, revision: imported.revision };
  const roundTrip = await answer<Export>(sample('round-trip-export', 'GET', exportPath(importedRecipe, person)));
  expect(roundTrip.recipe).toEqual(exported.recipe);
  expect(roundTrip.residuals.map(item => (item as { text: string }).text)).toEqual(['flour', 'flour']);
  expect(roundTrip.sourceObservations).toEqual([imported.sourceObservation]);
  type Page = { revision: string; ingredients: { originalText: string; amount: { numerator: number; denominator: number } }[]; occurrences: { occurrence: string; role: string; sourceKey?: string }[] };
  const page = await answer<Page>(sample('imported-recipe', 'GET', `/v1/recipes/works/${short(own.work)}${query(person)}`));
  expect(page.revision).toBe(imported.revision);
  expect(page.ingredients.map(item => item.amount)).toEqual([{ numerator: 3, denominator: 2 }, { numerator: 1, denominator: 4 }]);
  const lines = page.occurrences.filter(item => item.role === 'ingredient');
  expect(lines).toHaveLength(2);
  expect(new Set(lines.map(item => item.occurrence)).size).toBe(2);
  expect(page.occurrences.every(item => item.sourceKey?.startsWith(imported.sourceObservation))).toBe(true);
  // File possession carries no publication grant or claim of original authorship.
  expect(await answer<{ code: string }>(sample('publication-denied', 'POST', '/v1/work-publications', publish(importedRecipe, person)), 403))
    .toMatchObject({ code: 'authority_denied' });
  await answer(recording.session(name, sessions.visitor)('imported-recipe-concealed', 'GET', `/v1/recipes/works/${short(own.work)}`), 404);
  const second = await destination(person, sample, 'observation-destination');
  destinations.get(name)!.push({ prefix: 'observation-destination', recipe: second });
  const observationCommand = { actingSubject: person.actingSubject, expectedHead: second.revision,
    sourceObservation: imported.sourceObservation };
  const observationKey = randomUUID();
  const importedObservation = await answer<{ revision: string }>(sample('observation-import', 'POST', `/v1/recipes/${short(second.structure)}/imports`, observationCommand, observationKey));
  expect(await answer(sample('observation-import-replay', 'POST', `/v1/recipes/${short(second.structure)}/imports`, observationCommand, observationKey)))
    .toMatchObject({ revision: importedObservation.revision });
  const observationExport = await answer<Export>(sample('observation-export', 'GET', exportPath({ ...second, revision: importedObservation.revision }, person)));
  expect(observationExport.recipe).toEqual(roundTrip.recipe);
  expect(observationExport.sourceObservations).toEqual([imported.sourceObservation]);
}
async function withinDeadline(run: () => Promise<void>, milliseconds: number, phase: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([run(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${phase} exceeded ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function exchangeVisit(name: PersonaName) {
  const started = performance.now();
  let proofMs = 0;
  try {
    // Only exchangeRecipe is the acceptance proof; surface reads have their own budget afterwards.
    await withinDeadline(() => exchangeRecipe(name), 60_000, `${name} proof`);
    proofMs = performance.now() - started;
    await withinDeadline(async () => {
      await Promise.all([frameReads(name), exchangeReads(name, source, 'editor', name === 'owner')]);
      for (const { prefix, recipe } of destinations.get(name) ?? []) {
        await exchangeReads(name, recipe, `${prefix}-editor`, true);
        if (prefix === 'file-destination')
          await discard(recording.session(name, sessions[name])('file-import-stale-refresh', 'GET',
            `/v1/recipes/works/${short(recipe.work)}${query(sessions[name])}`));
      }
    }, 120_000, `${name} visit`);
  } finally {
    const elapsed = performance.now() - started;
    console.info(`[exchange-timing] ${name} proof=${(proofMs || elapsed).toFixed(0)}ms visit=${(proofMs ? elapsed - proofMs : 0).toFixed(0)}ms`);
  }
}

const discard = async (request: Promise<Response>) => { await (await request).body?.cancel(); };

// RecipeEditPage gates summary/metadata, then recipe/notes, on the Work's editor authority.
async function exchangeReads(name: PersonaName, recipe: Recipe, prefix: string, editor: boolean) {
  const person = sessions[name], sample = recording.session(name, person), id = short(recipe.work);
  await Promise.all([
    person.actingSubject ? discard(sample(`${prefix}-authority`, 'GET', `/v1/resources/${id}/page${query(person)}`)) : null,
    discard(sample(`${prefix}-work-header`, 'GET', `/v1/works/${id}${query(person)}`)),
  ]);
  if (!editor) return;
  await Promise.all([
    discard(sample(`${prefix}-resource-summary`, 'GET', `/v1/resources/${id}${query(person)}`)),
    discard(sample(`${prefix}-metadata-empty`, 'GET', `/v1/works/${id}/metadata${query(person)}`)),
  ]);
  await Promise.all([
    discard(sample(`${prefix}-recipe`, 'GET', `/v1/recipes/works/${id}${query(person)}`)),
    discard(sample(`${prefix}-notes-empty`, 'GET', `/v1/me/contributions${query(person)}&limit=20`)),
  ]);
}

// RootLayout and LocaleLayout share these reads for an English visit by Work UUID.
async function frameReads(name: PersonaName) {
  const person = sessions[name], sample = recording.session(name, person);
  const publicSample = recording.session(name, sessions.visitor);
  const official = async () => {
    const zones = await publicSample('frame-official-zones', 'GET', '/v1/zones?official=true&limit=6');
    if (!zones.ok) { await zones.body?.cancel(); return; }
    const page = await zones.json() as { items: { realm: string; routeSegment: string }[] };
    await Promise.all(page.items.slice(0, 6).map(zone =>
      discard(publicSample(`frame-official-realm-${zone.routeSegment}`, 'GET', `/v1/realms/${short(zone.realm)}`))));
  };
  const identity = async () => {
    if (!person.actingSubject) return;
    await Promise.all([
      discard(sample('frame-acting-contexts', 'GET', '/v1/me/acting-contexts?task=work.create')),
      discard(sample('frame-agent-choices', 'GET', '/v1/me/agents?languages=en')),
      discard(sample('frame-session-agent', 'GET', '/v1/me/session-agent')),
    ]);
    await Promise.all([
      discard(sample('frame-agent-profile', 'GET', `/v1/agents/${short(person.actingSubject)}${query(person)}`)),
      communities(),
    ]);
  };
  const communities = async () => {
    await discard(sample('frame-person-preferences', 'GET', `/v1/me/person-preferences${query(person)}`));
    await Promise.all([
      official(),
      discard(sample('frame-managed-realms', 'GET', `/v1/me/managed-realms${query(person)}`)),
      ...([
        ['frame-pinned-communities', { order: 'pinned', include: 'newSince' }],
        ['frame-space-communities', { kind: 'space', order: 'recent', include: 'newSince' }],
        ['frame-follow-inventory', {}],
      ] as const).map(([label, extra]) => {
        const params = new URLSearchParams({ actingSubject: person.actingSubject!, limit: '20', ...extra });
        return discard(sample(label, 'GET', `/v1/me/follows?${params}`));
      }),
    ]);
  };
  await Promise.all([
    discard(sample('frame-platform-access', 'GET', '/v1/me/platform-access')),
    discard(publicSample('frame-types', 'GET', '/v1/types')),
    person.actingSubject ? identity() : official(),
  ]);
}

outcomeTest(exchange, 'visitor', () => exchangeVisit('visitor'), recording);
outcomeTest(exchange, 'stranger', () => exchangeVisit('stranger'), recording);
outcomeTest(exchange, 'member', () => exchangeVisit('member'), recording);
outcomeTest(exchange, 'owner', () => exchangeVisit('owner'), recording);
outcomeTest(exchange, 'moderator', () => exchangeVisit('moderator'), recording);
outcomeTest(exchange, 'operator', () => exchangeVisit('operator'), recording);
