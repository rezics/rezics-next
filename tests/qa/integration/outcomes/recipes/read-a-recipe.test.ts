import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { browserMainApi, BFF_PREFIX } from '../../../../../apps/web/features/api/browser.ts';
import { seedTypes, typeEntry } from '../../../../../apps/web/features/catalogue/types.ts';
import { mainTrackingApi } from '../../../../../apps/web/features/tracking/api.ts';
import { progressControl } from '../../../../../apps/web/features/tracking/medium-progress.tsx';
import { authorize, exchangeCode, LocalOAuthSession, type LocalOAuthClient } from '../../../../../scripts/lib/oauth-client.ts';
import reading, { acting, originalRecipe, short, type RecipeWork } from '../../../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { OutcomeRecorder, outcomeResponse, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(120_000);
const recording = new OutcomeRecorder(reading);
let sessions: PersonaSessions;
let recipe: RecipeWork;
let hidden: RecipeWork;
let ownerHidden: RecipeWork;
type Page = { revision: string; structure: string; next?: string;
  occurrences: Array<{ occurrence: string; role: string; parent: string;
    labels: Array<{ value: string; language: string }>;
    qualifier?: { originalText?: { value: string; language: string }; instructionText?: { value: string; language: string } } }>;
  ingredients: Array<{ originalText: string; amount: { numerator: number; denominator: number } }>;
  measures: Array<{ kind: string }>; cost: { occurrences: number } };
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
beforeAll(async () => {
  sessions = await personaSessions('public');
  await recording.prepare();
  recipe = await originalRecipe(sessions.owner, 'Original paged sauce', { paged: true, laterDraft: true });
  // A different author owns the hidden control, so none of the tested personas owns it.
  hidden = await originalRecipe(sessions.stranger, 'Hidden stranger sauce', { published: false });
  ownerHidden = await originalRecipe(sessions.owner, 'Hidden owner sauce', { published: false });
}, 240_000);
afterAll(async () => {
  try { await recording.publish(); } finally { await sessions?.close(); }
});

async function read(name: PersonaName) {
  const person = await readingSession(sessions[name]);
  const sample = recording.session(name, proofSession(person));
  const path = `/v1/recipes/works/${short(recipe.work)}`;
  const query = new URLSearchParams(acting(person));
  query.set('servings', '8');
  const first = await answer<Page>(sample('recipe-scaled-start', 'GET', `${path}?${query}`));
  expect(first.revision).toBe(recipe.revision);
  expect(first.structure).toBe(recipe.structure);
  expect(first.next).toBeString();
  expect(first.occurrences.slice(0, 3).map(item => item.role)).toEqual(['group', 'ingredient', 'ingredient']);
  expect(first.occurrences[0]?.labels).toContainEqual({ value: 'Sauce', language: 'en' });
  expect(first.occurrences[1]?.parent).toBe(first.occurrences[0]?.occurrence);
  expect(first.measures.map(item => item.kind)).toContain('servings');
  const pages = [first];
  // The cursor carries servings forward without resending them.
  query.delete('servings');
  while (pages.at(-1)!.next) {
    expect(pages.length).toBeLessThan(4);
    query.set('cursor', pages.at(-1)!.next!);
    pages.push(await answer<Page>(sample(`recipe-scaled-page-${pages.length + 1}`, 'GET', `${path}?${query}`)));
  }
  expect(pages).toHaveLength(2);
  const occurrences = pages.flatMap(page => page.occurrences);
  expect(occurrences.map(item => item.occurrence)).toEqual(recipe.occurrenceIds);
  expect(new Set(occurrences.map(item => item.occurrence)).size).toBe(recipe.occurrenceIds.length);
  expect(pages.every(page => page.revision === recipe.revision)).toBe(true);
  expect(pages.flatMap(page => page.ingredients).map(item => item.originalText)).toEqual(recipe.ingredientTexts);
  expect(pages.flatMap(page => page.ingredients).every(item => item.amount.numerator === 3 && item.amount.denominator === 1)).toBe(true);
  expect(occurrences.filter(item => item.role === 'step').map(item => item.qualifier?.instructionText))
    .toEqual([{ value: 'Mix the sauce.', language: 'en' }, { value: 'Cook for five minutes.', language: 'en' }]);
  expect(occurrences.filter(item => item.role === 'group').map(item => item.labels[0]?.value)).toEqual(['Sauce', 'Empty garnish']);
  query.set('cursor', first.next!);
  const replay = await answer<Page>(sample('recipe-continuation-replay', 'GET', `${path}?${query}`));
  expect(replay.occurrences).toEqual(pages[1]!.occurrences);
  query.set('servings', '3');
  await answer(sample('cursor-servings-refused', 'GET', `${path}?${query}`), 400);
  query.delete('servings');
  const cursor = first.next!;
  query.set('cursor', `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`);
  await answer(sample('cursor-tampering-refused', 'GET', `${path}?${query}`), 400);
  for (const servings of ['1.5', '101']) await answer(sample(`servings-${servings}-refused`, 'GET', `${path}?${acting(person)}&servings=${servings}`), 400);
  {
    const privateWork = name === 'stranger' ? ownerHidden : hidden;
    const hiddenAnswer = await sample('private-work-refused', 'GET', `/v1/recipes/works/${short(privateWork.work)}?${acting(person)}`);
    const absentAnswer = await sample('absent-work-refused', 'GET', `/v1/recipes/works/00000000-0000-4000-8000-000000000099?${acting(person)}`);
    expect([hiddenAnswer.status, await hiddenAnswer.text()]).toEqual([absentAnswer.status, await absentAnswer.text()]);
    expect(hiddenAnswer.status).toBe(404);
  }
  if (name === 'owner') {
    const preview = await answer<{ revision: string }>(sample('private-draft-preview', 'GET',
      `/v1/compositions/${short(recipe.structure)}/revisions/${short(recipe.draftRevision!)}?${acting(person)}`));
    expect(preview.revision).toBe(recipe.draftRevision);
  }
  await recipePageReads(name, person, sample);
}
outcomeTest(reading, 'visitor', () => read('visitor'), recording);
outcomeTest(reading, 'stranger', () => read('stranger'), recording);
outcomeTest(reading, 'member', () => read('member'), recording);
outcomeTest(reading, 'owner', () => read('owner'), recording);
outcomeTest(reading, 'moderator', () => read('moderator'), recording);
outcomeTest(reading, 'operator', () => read('operator'), recording);

// A server fault must fail the proof before it can become a recorded refusal.
function proofSession(person: PersonaSession): Pick<PersonaSession, 'main'> {
  return { main: async (...args) => {
    const response = await person.main(...args);
    if (response.status >= 500) throw new Error(`API fault ${args[0]} ${args[1]}: ${response.status}: ${await response.clone().text()}`);
    return response;
  } };
}

// One English, global-scope visit to /en/w/{id}: WorkFrameView and WorkOverview,
// including the recipe continuation opened by RecipeExperience.
async function recipePageReads(name: PersonaName, person: PersonaSession, sample: ReturnType<OutcomeRecorder['session']>) {
  const id = short(recipe.work);
  const publicSample = recording.session(name, proofSession(sessions.visitor));
  const registry = await publicSample('type-registry', 'GET', '/v1/types');
  seedTypes(await registry.json());
  const viewer = (path: string) => person.actingSubject
    ? `${path}${path.includes('?') ? '&' : '?'}${acting(person)}` : path;
  const get = async <T,>(label: string, path: string): Promise<T> => {
    const response = await sample(label, 'GET', viewer(path));
    const raw = await response.text();
    if (response.status !== 200) throw new Error(`Page read GET ${viewer(path)}: ${response.status}: ${raw}`);
    return JSON.parse(raw) as T;
  };
  const [header, projection, page, credits, contexts] = await Promise.all([
    get<{ mainVersion: string; selectedLanguage: string | null }>('work-header', `/v1/works/${id}`),
    get<{ sections: Array<{ id: string; href: string }> }>('page-projection', `/v1/resources/${id}/page`),
    get<Page>('recipe-start', `/v1/recipes/works/${id}`),
    get<{ items: Array<{ role: string; agent: string }> }>('agent-credits', `/v1/works/${id}/agent-credits`),
    get<{ items: Array<{ context: string }> }>('rating-contexts', `/v1/resources/${id}/rating-contexts?scope=global`),
  ]);
  if (person.actingSubject) await get('recipe-edit-authority', `/v1/resources/${id}/page`);
  if (page.next) await get('recipe-continuation', `/v1/recipes/works/${id}?${new URLSearchParams({ cursor: page.next })}`);
  const language = header.selectedLanguage ? `?${new URLSearchParams({ language: header.selectedLanguage })}` : '';
  // readText sends no actingSubject, even when its client has the viewer's bearer.
  await (await sample('recipe-notes-empty', 'GET', `/v1/main-versions/${short(header.mainVersion)}/selection${language}`)).body?.cancel();
  const author = credits.items.find(item => item.role === 'author');
  if (author) await get('author-works', `/v1/agents/${short(author.agent)}/works?limit=12`);
  const context = contexts.items[0]?.context;
  await get('ratings', `/v1/resources/${id}/ratings?${new URLSearchParams({ scope: 'global', ...(context ? { context } : {}) })}`);
  await get('reader-stats', `/v1/works/${id}/reader-stats${context ? `?${new URLSearchParams({ context })}` : ''}`);
  if (context) await get('reviews-empty', `/v1/resources/${id}/reviews?${new URLSearchParams({ context, sort: 'helpful', limit: '10' })}`);
  const reads: [string, string][] = [
    ['availability-realizations-empty', `/v1/works/${id}/realizations?limit=20`],
    ['availability-releases-empty', `/v1/works/${id}/releases?limit=20`],
    ['availability-parts', `/v1/resources/${id}/parts?limit=1`],
    ['parts-preview', `/v1/resources/${id}/parts?limit=7`],
    ['wholes-preview-empty', `/v1/resources/${id}/wholes?limit=3`],
    ['connections-empty', `/v1/resources/${id}/relations?limit=20`],
    ['review-target-relations-empty', `/v1/resources/${id}/relations?limit=32`],
    ['classifications-empty', `/v1/works/${id}/classifications?scope=global`],
    ['rating-populations', `/v1/rating-populations?${new URLSearchParams({ limit: '20', target: recipe.work })}`],
    ['also-enjoyed-empty', `/v1/works/${id}/also-enjoyed?limit=12`],
  ];
  await Promise.all(reads.map(async ([label, path]) => {
    const response = await sample(label, 'GET', viewer(path));
    await response.body?.cancel();
  }));
  if (person.actingSubject) await get('reader-state-empty', `/v1/works/${id}/reader-state`);
  if (person.actingSubject) await recipeProgressReads(person, sample);
  // WorkFrame's follow control calls state(work.id) without a kind or body.
  if (person.actingSubject) await (await sample('recipe-follow-state', 'GET',
    `/v1/me/follow-state?${new URLSearchParams({ actingSubject: person.actingSubject, target: recipe.work })}`)).body?.cancel();
  const statements = projection.sections.find(section => section.id === 'statements');
  if (statements) {
    type Fact = { kind: string; value: { kind: string; iri?: string; ref?: string }; qualifiers: { applicability: string[] } };
    const facts = await get<{ groups: Array<{ predicate: string; items: Fact[] }> }>('work-facts', statements.href);
    const definitions = [...new Set(facts.groups.map(group => group.predicate))]
      .filter(predicate => /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(predicate));
    for (let offset = 0; offset < definitions.length; offset += 64)
      await get(`fact-predicate-labels-${offset / 64 + 1}`, `/v1/lexicon/presentations?${new URLSearchParams({
        definitions: definitions.slice(offset, offset + 64).join(','), languages: 'en',
      })}`);
    const resources = [...new Set(facts.groups.flatMap(group => group.items.flatMap(item => [
      ...item.kind === 'statement' && item.value.kind === 'resource' && item.value.iri ? [item.value.iri] : [],
      ...item.kind === 'component-property' && item.value.kind === 'resource' && item.value.ref ? [item.value.ref] : [],
      ...item.qualifiers.applicability,
    ])))];
    for (let offset = 0; offset < resources.length; offset += 64)
      await (await sample(`fact-resource-names-${offset / 64 + 1}`, 'POST', '/v1/resources/summaries', {
        profile: 'resource-summary-batch-v1', resources: resources.slice(offset, offset + 64),
        ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
      })).body?.cancel();
  }
  const discussion = projection.sections.find(section => section.id === 'discussion');
  if (discussion) await get('discussion-empty', discussion.href);
  for (const query of ['work-credits', 'work-adoptions']) await (await sample(query, 'POST', '/v1/query', {
    profile: 'template-query-v1', query: `https://rezics.com/query/${query}`, revision: 1,
    parameters: { roots: [recipe.work] }, presentation: person.actingSubject ? { actingSubject: person.actingSubject } : {},
  })).body?.cancel();
  await (await publicSample('work-showcase', 'POST', '/v1/resources/showcase', {
    profile: 'work-showcase-batch-v1', targets: [recipe.work],
  })).body?.cancel();
  await (await publicSample('metadata-public-preview', 'GET', `/v1/public-previews/${id}`)).body?.cancel();
  await (await publicSample('metadata-work-header', 'GET', `/v1/works/${id}`)).body?.cancel();
  await (await publicSample('classification-facets', 'GET', '/v1/facets')).body?.cancel();
  await (await sample('platform-access', 'GET', '/v1/me/platform-access')).body?.cancel();
}

// Use the production tracking client so its paths, query order and headers are recorded unchanged.
// The frame's successful reader-state seed supplies tracking, including media and episodes.
async function recipeProgressReads(person: PersonaSession, sample: ReturnType<OutcomeRecorder['session']>) {
  const client = (label: string) => browserMainApi('http://recipe-page.local', { fetcher: async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.slice(BFF_PREFIX.length) + url.search;
    const suffix = url.pathname.endsWith('/realizations') ? '-realizations'
      : url.pathname.endsWith('/releases') ? '-releases' : '';
    return sample(label + suffix, init?.method ?? 'GET', path, undefined, undefined,
      { headers: Object.fromEntries(new Headers(init?.headers).entries()) });
  } });
  const api = (label: string) => mainTrackingApi(person.actingSubject!, () => client(label));
  await Promise.all([
    api('progress-edition-preference').preference(recipe.work),
    api('progress-editions').editions(recipe.work),
    api('progress-relations').relations(recipe.work),
    api('progress-equivalent-definition').definition('correspondence-equivalent'),
  ]);
  // SeriesPartsPanel initially uses the interface language, even before a saved preference is applied.
  await api('progress-series-summary').series(recipe.work, 'en');
  const media = api('progress-medium-types').media!;
  const types = await media.types(recipe.work);
  if (!types.ok && types.failure === 'missing') return;
  const presentation = types.ok && types.data ? typeEntry(types.data)?.presentation ?? null : null;
  const choice = await progressControl(api('progress-medium-parts').media!, api('progress-episode-structure').episodes!,
    recipe.work, presentation);
  if (choice.kind === 'chapters') {
    const standing = await api('progress-chapter-standing').media!.standing(recipe.work);
    if (standing.ok && !standing.data.opened) await api('progress-chapter-positions').media!.positions(recipe.work);
  } else if (choice.kind === 'work') await api('progress-work-standing').media!.workStanding(recipe.work);
}

async function readingSession(person: PersonaSession): Promise<PersonaSession> {
  if (!person.accountId) return person;
  const stack = resolve('.temp/stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`);
  const directory = readdirSync(stack).find((name) => name.startsWith('g-1005-auth-'));
  if (!directory) throw new Error('Persona OAuth public configuration is unavailable');
  const config = JSON.parse(readFileSync(resolve(stack, directory, 'public.json'), 'utf8')) as {
    clientId: string;
    redirectUris: string[];
    scope: string;
  };
  const client: LocalOAuthClient = {
    account: Bun.env.ACCOUNT_BASE_URL!,
    clientId: config.clientId,
    redirectUri: config.redirectUris[0]!,
    scope: config.scope,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
    fetch: async (input, init) => {
      const url = new URL(input);
      // The existing Account transport carries this person's live session cookie.
      if (url.pathname === '/api/auth/oauth2/authorize')
        return person.account('GET', `${url.pathname}${url.search}`);
      if (url.pathname === '/api/account/consent')
        return person.account(
          'POST',
          `${url.pathname}${url.search}`,
          JSON.parse(String(init?.body)),
        );
      return fetch(input, init);
    },
  };
  const authorized = await authorize(client, '');
  if (!authorized.ok)
    throw new Error(`Persona authorization returned HTTP ${authorized.response.status}`);
  const grant = await exchangeCode(client, authorized);
  const oauth = new LocalOAuthSession(client, grant, Date.now() + (grant.expires_in ?? 300) * 1000);
  const sessionKey = randomUUID();
  return {
    ...person,
    main: async (method, path, body, key, options) => {
      const headers = new Headers({
        authorization: `Bearer ${await oauth.current(Date.now(), 60_000)}`,
        'x-session-key': sessionKey,
      });
      for (const [name, value] of Object.entries(options?.headers ?? {})) {
        if (value) headers.set(name, value);
        else headers.delete(name);
      }
      if (body !== undefined) headers.set('content-type', 'application/json');
      if (key !== undefined || !['GET', 'HEAD'].includes(method))
        headers.set('idempotency-key', key ?? randomUUID());
      const request = (signal: AbortSignal) =>
        fetch(new URL(path, `http://127.0.0.1:${Bun.env.MAIN_PORT}`), {
          method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      return ['GET', 'HEAD'].includes(method)
        ? outcomeResponse(request)
        : request(AbortSignal.timeout(30_000));
    },
  };
}
