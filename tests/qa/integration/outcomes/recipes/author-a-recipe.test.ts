import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import authoring from '../../../../../scripts/qa/cases/outcomes/recipes/author-a-recipe.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(180_000);
// The API outcome proof owns 60 seconds; the subsequent surface visit owns 120 seconds.
const proofDeadlineMs = 60_000;
const visitDeadlineMs = 120_000;
const destinations = new Map<PersonaName, Recipe>();
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
    destinations.set(name, own);
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
  await Promise.all([
    person.actingSubject ? answer(sample('editor-authority', 'GET', `/v1/resources/${id}/page${query(person)}`)) : Promise.resolve(),
    answer(sample('editor-work-header', 'GET', `/v1/works/${id}${query(person)}`)),
  ]);
  if (name !== 'owner') return;
  await Promise.all([
    answer(sample('editor-resource-summary', 'GET', `/v1/resources/${id}${query(person)}`)),
    answer(sample('editor-metadata-empty', 'GET', `/v1/works/${id}/metadata${query(person)}`)),
  ]);
  await Promise.all([
    answer(sample('editor-recipe-draft', 'GET', `/v1/recipes/works/${id}${query(person)}`)),
    answer(sample('editor-notes-empty', 'GET', `/v1/me/contributions${query(person)}&limit=20`)),
  ]);
}

async function within<T>(milliseconds: number, phase: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${phase} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function visit(name: PersonaName) {
  const person = sessions[name], sample = recording.session(name, person);
  await Promise.all([sample('frame-types', 'GET', '/v1/types'), editorReads(name, recipe.work)]);
  const destination = name === 'owner' ? recipe : destinations.get(name);
  if (destination) await workReads(name, destination);
}

// WorkFrameView, WorkOverview and the mounted SeriesProgressPanel share cached reads,
// but their uncached previews keep separate labels even when their paths are equal.
async function workReads(name: PersonaName, value: Recipe) {
  const person = sessions[name], sample = recording.session(name, person);
  const publicSample = recording.session(name, sessions.visitor);
  const id = short(value.work), resource = `/v1/resources/${id}`, work = `/v1/works/${id}`;
  const parameters = (extra: Record<string, string> = {}) => `?${new URLSearchParams({
    actingSubject: person.actingSubject!, ...extra,
  })}`;
  const read = async <T,>(label: string, path: string): Promise<T> => {
    const started = performance.now();
    let status: number | 'error' = 'error';
    try {
      const response = await sample(label, 'GET', path);
      status = response.status;
      return await response.json() as T;
    } finally {
      if (label === 'destination-also-enjoyed') console.info('[destination-also-enjoyed]', JSON.stringify({
        persona: name, method: 'GET', path, elapsedMs: Math.round(performance.now() - started), status,
      }));
    }
  };
  const template = async (label: string, kind: string) => (await sample(label, 'POST', '/v1/query', {
    profile: 'template-query-v1', query: `https://rezics.com/query/work-${kind}`, revision: 1,
    parameters: { roots: [value.work] }, presentation: { actingSubject: person.actingSubject },
  })).json();
  const header = await read<{ selectedLanguage: string | null }>('destination-work-header', `${work}${parameters()}`);
  await Promise.all([
    // SEO and art deliberately use the anonymous client in production.
    publicSample('destination-public-preview', 'GET', `/v1/public-previews/${id}`),
    publicSample('destination-public-header', 'GET', work),
    publicSample('destination-showcase', 'POST', '/v1/resources/showcase', {
      profile: 'work-showcase-batch-v1', targets: [value.work],
    }),
    read('destination-reader-state', `${work}/reader-state${parameters()}`),
    read('destination-projection', `${resource}/page${parameters()}`),
    read('destination-agent-credits', `${work}/agent-credits${parameters()}`).then(async credits => {
      const native = (credits as { items?: { role: string; agent: string }[] }).items?.find(item => item.role === 'author');
      if (native) await read('destination-author-works', `/v1/agents/${short(native.agent)}/works${parameters({ limit: '12' })}`);
    }),
    template('destination-external-credits', 'credits'),
    read<{ items?: { context: string }[] }>('destination-rating-contexts', `${resource}/rating-contexts${parameters({ scope: 'global' })}`).then(async contexts => {
      const context = contexts.items?.[0]?.context;
      await Promise.all([
        read('destination-rating-summary', `${resource}/ratings${parameters({ scope: 'global', ...(context ? { context } : {}) })}`),
        read('destination-reader-stats', `${work}/reader-stats${parameters(context ? { context } : {})}`),
        ...(context ? [read('destination-reviews', `${resource}/reviews${parameters({ context, sort: 'helpful', limit: '10' })}`).then(async () => {
          await Promise.all([
            read('destination-review-releases', `${work}/releases${parameters({ limit: '20' })}`),
            read('destination-review-realizations', `${work}/realizations${parameters({ limit: '20' })}`),
            read('destination-review-relations', `${resource}/relations${parameters({ limit: '32' })}`),
          ]);
        })] : []),
      ]);
    }),
    read('destination-recipe', `/v1/recipes/works/${id}${parameters()}`),
    read('destination-text-selection', `/v1/main-versions/${short(value.mainVersion)}/selection${header.selectedLanguage
      ? `?${new URLSearchParams({ language: header.selectedLanguage })}` : ''}`),
    read('destination-editor-authority', `${resource}/page${parameters()}`),
    read('destination-statements', `${resource}/statements${parameters()}`),
    read('destination-wiki-statements', `${resource}/statements${parameters()}`),
    read('destination-realizations', `${work}/realizations${parameters({ limit: '20' })}`),
    read('destination-releases', `${work}/releases${parameters({ limit: '20' })}`),
    read('destination-availability-parts', `${resource}/parts${parameters({ limit: '1' })}`),
    read('destination-parts', `${resource}/parts${parameters({ limit: '7' })}`),
    read('destination-wholes', `${resource}/wholes${parameters({ limit: '3' })}`),
    read('destination-connections', `${resource}/relations${parameters({ limit: '20' })}`),
    read('destination-rating-populations', `/v1/rating-populations?${new URLSearchParams({ target: value.work, limit: '20', actingSubject: person.actingSubject! })}`),
    read('destination-classifications', `${work}/classifications${parameters({ scope: 'global' })}`),
    publicSample('destination-facets', 'GET', '/v1/facets'),
    read('destination-discussion', `${resource}/discussion${parameters()}`),
    template('destination-adoptions', 'adoptions'),
    read('destination-also-enjoyed', `${work}/also-enjoyed${parameters({ limit: '12' })}`),
  ]);
  // The client panel opens its own copies after hydration, then progress in the chosen language.
  const [preference] = await Promise.all([
      read<{ language?: string } | null>('destination-series-preference', `/v1/me/edition-preferences/${id}${parameters()}`),
      read('destination-series-realizations', `${work}/realizations${parameters({ limit: '20' })}`),
      read('destination-series-releases', `${work}/releases${parameters({ limit: '20' })}`),
      read('destination-series-relations', `${resource}/relations${parameters({ limit: '20' })}`),
      read('destination-series-correspondence', `/v1/lexicon/definitions/correspondence-equivalent${parameters()}`),
  ]);
  await read('destination-series-progress', `/v1/me/progress-summaries/${id}${parameters({ language: preference?.language ?? 'en' })}`);
}

async function proveAndVisit(name: PersonaName) {
  const started = performance.now();
  let proofMs = 0, visitMs = 0;
  try {
    await within(proofDeadlineMs, `${name} proof`, () => author(name));
    proofMs = performance.now() - started;
    const visitStarted = performance.now();
    try { await within(visitDeadlineMs, `${name} visit`, () => visit(name)); }
    finally { visitMs = performance.now() - visitStarted; }
  } finally {
    console.info(`[persona-timing] ${name} proof=${Math.round(proofMs || performance.now() - started)}ms visit=${Math.round(visitMs)}ms`);
  }
}

outcomeTest(authoring, 'visitor', () => proveAndVisit('visitor'), recording);
outcomeTest(authoring, 'stranger', () => proveAndVisit('stranger'), recording);
outcomeTest(authoring, 'member', () => proveAndVisit('member'), recording);
outcomeTest(authoring, 'owner', () => proveAndVisit('owner'), recording);
outcomeTest(authoring, 'moderator', () => proveAndVisit('moderator'), recording);
outcomeTest(authoring, 'operator', () => proveAndVisit('operator'), recording);
