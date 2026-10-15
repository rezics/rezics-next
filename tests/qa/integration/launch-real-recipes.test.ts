import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readEnv } from '../../../scripts/dev/config.ts';
import { root } from '../../../scripts/fixture/stack.ts';
import { createCorpusBackupDriver, type CorpusRestoreSmokeInput } from '../../../scripts/load/corpus-backup-driver.ts';
import { launchRecipeSources, loadLaunchRecipesCorpus, prepareRestoredRecipeBrowse,
  restoreLaunchRecipesCorpus, type LaunchRecipesCorpus }
  from '../../../scripts/load/launch-corpus.ts';
import { workProfileCorpusApi, type CorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';

const short = (id: string) => id.slice(-36);

function apiFor(stack: MediaStack, token: string): CorpusApi {
  return workProfileCorpusApi('http://main.local', token, {
    fetch: (async (input, init) => {
      for (let attempt = 0; ; attempt++) {
        init?.signal?.throwIfAborted();
        const response = await stack.main.handle(new Request(input, init));
        if (response.status !== 202 || attempt === 2) return response;
        const pending = await response.json() as { retry?: { allowed?: boolean; afterMs?: number } };
        if (!pending.retry?.allowed) throw new Error('Recipe corpus command cannot be retried');
        await Bun.sleep(Math.min(1000, Math.max(0, pending.retry.afterMs ?? 1000)));
      }
    }) as typeof fetch,
  });
}

async function openCopy(input: CorpusRestoreSmokeInput) {
  const env = { ...input.apps, REZICS_QA_RUN_ID: input.runId, REZICS_QA_STACK_MODE: 'scale',
    REZICS_QA_STACK_TIER: 'integration', REZICS_STACK_PROFILE: 'qa' };
  const previous = new Map(Object.keys(env).map(key => [key, Bun.env[key]]));
  Object.assign(Bun.env, env);
  let stack: MediaStack | undefined;
  try {
    stack = await startMediaStack('launch-recipes-restored', { library: true, ownerUrls: {
      access: input.apps.ACCESS_DATABASE_URL!, content: input.apps.CONTENT_DATABASE_URL!,
      relay: input.apps.ACCOUNT_RELAY_DATABASE_URL!,
    } });
    input.signal.throwIfAborted();
    const readinessStarted = performance.now();
    try {
      await prepareRestoredRecipeBrowse(stack, input.signal);
      input.signal.throwIfAborted();
      console.log(JSON.stringify({ stage: 'restored-zone-browse-readiness',
        readinessMs: Math.round(performance.now() - readinessStarted) }));
    } catch (error) {
      const readinessMs = Math.round(performance.now() - readinessStarted);
      console.log(JSON.stringify({ stage: 'restored-zone-browse-readiness', readinessMs, outcome: 'failed' }));
      throw new Error(`Restored Zone browse readiness failed after ${readinessMs} ms`, { cause: error });
    }
    const workObjects = stack.objects('semantic/work/');
    const structureObjects = stack.objects('semantic/structure/');
    await Promise.all([workObjects.initialize(), structureObjects.initialize()]);
    Object.assign(stack.env, { objectDirectory: input.apps.MAIN_OBJECT_DIRECTORY!, workObjects, structureObjects });
    return stack;
  } catch (error) {
    await stack?.stop();
    throw error;
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  }
}

interface RecipePage {
  profile: 'recipe-work-page-v1';
  structure: string;
  revision: string;
  occurrences: { occurrence: string; role: string; parent: string; sourceKey?: string;
    qualifier?: { originalText?: { value: string; language: string };
      instructionText?: { value: string; language: string }; usesIngredient?: string[] } }[];
  ingredients: { occurrence: string; originalText: string; amount?: { numerator: number; denominator: number };
    amountUpper?: { numerator: number; denominator: number } }[];
  next?: string;
}

interface ZoneBrowsePage {
  profile: 'zone-browse-v1';
  items: { id: string; title: { value: string } }[];
  matches: { value: number; kind: 'exact' | 'lower-bound' };
  window: { scanned: number; complete: boolean };
  nextCursor: string | null;
}

let corpus: LaunchRecipesCorpus;
let recipeApi: CorpusApi;
let recipeActor = '';
const copies = new Map<string, MediaStack>();
const target = 'isolated';
let targetName = '';
let driver: ReturnType<typeof createCorpusBackupDriver> | undefined;

test('Gutenberg recipe pins select 30 ordered extracts and preserve the approved source lines', () => {
  const recipes = launchRecipeSources();
  expect(recipes).toHaveLength(30);
  expect(recipes.filter(item => item.language === 'en')).toHaveLength(20);
  expect(recipes.filter(item => item.language === 'it')).toHaveLength(10);
  expect(recipes.flatMap(item => item.ingredients)).toHaveLength(173);
  expect(recipes.flatMap(item => item.ingredients).join('\n').match(/(?:\d+\s*)?[½¼¾⅓⅔⅛⅜⅝⅞]/gu)).toHaveLength(47);
  expect(recipes.flatMap(item => item.ingredients).join('\n').match(/\b\d+\s+(?:to|or)\s+\d+\b/giu)).toHaveLength(2);
  expect(recipes.find(item => item.recipeId === 'puff-paste')?.caseIds)
    .toEqual(['boston-puff-paste-flour-dough-and-rolling']);
});

beforeAll(async () => {
  const sourceRunId = Bun.env.REZICS_QA_RUN_ID;
  if (!sourceRunId) throw new Error('Run through goalctl integration QA');
  const compose = readEnv(join(root, '.temp/stack', `rezics-qa-${sourceRunId}`, 'compose.env'));
  if (compose.REZICS_STACK_STORAGE !== 'persistent')
    throw new Error('Launch recipe restore needs persistent catalogue-disk allocation (REZICS_QA_STACK_MODE=scale)');
  if (compose.REZICS_STACK_RAW_UPDATE === '1')
    throw new Error('Launch recipe restore needs commandOnlyIntegrationFiles registration for public Realm writes');
  corpus = loadLaunchRecipesCorpus();
  expect(corpus.counts).toEqual({ works: 30, recipes: 30, ingredientLines: 173, fractionLines: 47,
    rangeLines: 2, englishRecipes: 20, italianRecipes: 10 });
  expect(corpus.records).toHaveLength(30);
  targetName = `launch-recipes-${sourceRunId}-${target}`;
  driver = createCorpusBackupDriver({ sourceRunId,
    directory: join(root, '.temp/launch-corpus/recipes/backups'), resumeSource: false,
    async quiesce() {
      throw new Error('The launch recipes integration test restores a retained API corpus and never backs it up');
    },
    async smokeRead(input) {
      const stack = await openCopy(input);
      try {
        const importer = await stack.member('launch-recipes-importer', { stable: true, verified: true });
        const api = apiFor(stack, importer.token);
        const pathFor = (cursor?: string) => {
          const query = new URLSearchParams({ limit: '20' });
          if (cursor) query.set('cursor', cursor);
          return `/v1/realms/${short(corpus.realm)}/modules/browse?${query}` as const;
        };
        const pages: ZoneBrowsePage[] = [];
        let cursor: string | undefined;
        do {
          const page = await api.read<ZoneBrowsePage>(pathFor(cursor));
          pages.push(page);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        const ids = pages.flatMap(page => page.items.map(item => item.id));
        expect(pages.at(-1)?.window.complete, JSON.stringify({ pages: pages.map(page => ({
          items: page.items.length, matches: page.matches, window: page.window,
          continuation: Boolean(page.nextCursor) })), recovery: stack.composition.zoneBrowse?.recoveryStatus() })).toBe(true);
        expect(pages.at(-1)?.matches).toEqual({ value: corpus.records.length, kind: 'exact' });
        expect(new Set(ids)).toEqual(new Set(corpus.records.map(item => item.work)));
        copies.set(input.target, stack);
        return async () => { copies.delete(input.target); await stack.stop(); };
      } catch (error) {
        await stack.stop();
        throw error;
      }
    },
  });
  const restoreMs = await restoreLaunchRecipesCorpus(corpus, targetName, driver!);
  expect(restoreMs).toBeLessThan(480_000);
  const restored = copies.get(targetName)!;
  const importer = await restored.member('launch-recipes-importer', { stable: true, verified: true });
  recipeActor = importer.actor;
  recipeApi = apiFor(restored, importer.token);
}, 480_000);

afterAll(async () => {
  if (targetName) await driver?.stop(targetName);
}, 120_000);

async function readRecipe(record: LaunchRecipesCorpus['records'][number]): Promise<RecipePage[]> {
  const pages: RecipePage[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ actingSubject: recipeActor });
    if (cursor) query.set('cursor', cursor);
    const page = await recipeApi.read<RecipePage>(`/v1/recipes/works/${short(record.work)}?${query}`);
    pages.push(page);
    cursor = page.next;
  } while (cursor);
  return pages;
}

async function readAllBrowsePages(api: CorpusApi, realm: string, q?: string): Promise<ZoneBrowsePage[]> {
  const pages: ZoneBrowsePage[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: '20' });
    if (q) query.set('q', q);
    if (cursor) query.set('cursor', cursor);
    const page = await api.read<ZoneBrowsePage>(`/v1/realms/${short(realm)}/modules/browse?${query}`);
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return pages;
}

test('Gutenberg recipes publish as copied public-domain text with source and author credit', async () => {
  for (const record of corpus.records) {
    const header = await recipeApi.read<{ rights: { basis: string; source: {
      provider: string; externalId: string; url: string; license: string; author: string;
      observation: string; transcriber: string } } }>(`/v1/works/${short(record.work)}`);
    expect(header.rights.basis).toBe('public-domain');
    expect(header.rights.source).toMatchObject({ provider: 'gutenberg',
      license: 'https://www.gutenberg.org/policy/license.html',
      author: record.pinId === 'artusi' ? 'Pellegrino Artusi' : 'Fannie Merritt Farmer' });
    expect(header.rights.source.externalId).toEndWith(`/${record.recipeId}`);
    const credits = await recipeApi.read<{ items: Array<{ role: string; agent: string | null; displayName: string }> }>(
      `/v1/works/${short(record.work)}/credits`);
    expect(credits.items).toContainEqual(expect.objectContaining({ role: 'author', agent: null,
      displayName: header.rights.source.author }));
    expect(credits.items).toContainEqual(expect.objectContaining({ role: 'transcriber', agent: header.rights.source.transcriber }));
    expect(credits.items.some(item => item.role === 'author' && item.agent === header.rights.source.transcriber)).toBe(false);
  }
});

test('recipes / Pinned Schema.org imports retain ordered content, quantities and separate flour steps', async () => {
  const sources = launchRecipeSources();
  const sourceByKey = new Map(sources.map(item => [`${item.pinId}/${item.recipeId}`, item]));
  const failures: string[] = [];
  const recipePages = new Map<string, RecipePage[]>();
  for (const record of corpus.records) {
    const sourceRecipe = sourceByKey.get(`${record.pinId}/${record.recipeId}`)!;
    const pages = await readRecipe(record);
    recipePages.set(record.work, pages);
    const ingredients = pages.flatMap(item => item.ingredients);
    const occurrences = pages.flatMap(item => item.occurrences);
    if (pages.some(item => item.revision !== record.revision)) failures.push(`${record.title}: read revision differs from import`);
    const expectedIngredients = sourceRecipe.ingredients.map(line => line.trim());
    if (JSON.stringify(ingredients.map(item => item.originalText)) !== JSON.stringify(expectedIngredients))
      failures.push(`${record.title}: ingredient order or duplicate occurrences differ`);
    const expectedMethods = sourceRecipe.methods.map(line => line.trim());
    const actualMethods = occurrences.filter(item => item.role === 'step')
      .map(item => item.qualifier?.instructionText?.value ?? '');
    if (JSON.stringify(actualMethods) !== JSON.stringify(expectedMethods)) failures.push(`${record.title}: method lines differ`);
    const languages = occurrences.flatMap(item => {
      const language = item.role === 'ingredient' ? item.qualifier?.originalText?.language
        : item.role === 'step' ? item.qualifier?.instructionText?.language : undefined;
      return language ? [language] : [];
    });
    if (languages.some(language => language !== sourceRecipe.language)) failures.push(`${record.title}: imported language differs`);
    if (record.language === 'it' && languages.length !== expectedIngredients.length + expectedMethods.length)
      failures.push(`${record.title}: Italian language tags are missing`);
  }

  const quantities = corpus.records.flatMap(record => {
    const sourceRecipe = sourceByKey.get(`${record.pinId}/${record.recipeId}`)!;
    const ingredients = (recipePages.get(record.work) ?? []).flatMap(item => item.ingredients);
    return sourceRecipe.ingredients.map((line, index) => ({ record, line: line.trim(), index, ingredients }));
  });
  const fractionRows = quantities.filter(row => /[½¼¾⅓⅔⅛⅜⅝⅞]/u.test(row.line));
  const rangeRows = quantities.filter(row => /\b\d+\s+(?:to|or)\s+\d+\b/iu.test(row.line));
  // A suffix amount is kept as text.
  const suffixFraction = fractionRows.find(row => row.record.recipeId === 'lemon-pie-iv'
    && row.line === 'Grated rind ½ lemon');
  expect(suffixFraction).toBeDefined();
  const suffixIngredient = suffixFraction!.ingredients[suffixFraction!.index];
  expect(suffixIngredient?.originalText).toBe('Grated rind ½ lemon');
  expect(suffixIngredient?.amount).toBeUndefined();
  expect(suffixIngredient?.amountUpper).toBeUndefined();
  for (const row of quantities) {
    const actual = row.ingredients[row.index];
    if (/[½¼¾⅓⅔⅛⅜⅝⅞]/u.test(row.line) && row !== suffixFraction && !actual?.amount)
      failures.push(`${row.record.title}: fraction has no parsed amount (${row.line})`);
    if (/\b\d+\s+(?:to|or)\s+\d+\b/iu.test(row.line)
      && (!actual?.amount || !actual.amountUpper))
      failures.push(`${row.record.title}: range is not retained as lower and upper quantities (${row.line})`);
  }
  if (fractionRows.filter(row => row.ingredients[row.index]?.amount).length !== 46)
    failures.push('Recipe corpus: all 46 prefix fractions must be retained as parsed quantities');
  if (rangeRows.filter(row => row.ingredients[row.index]?.amount && row.ingredients[row.index]?.amountUpper).length !== 2)
    failures.push('Recipe corpus: both source ranges must be retained as lower and upper quantities');

  const puff = corpus.records.find(item => item.recipeId === 'puff-paste')!;
  const puffPages = recipePages.get(puff.work)!;
  const puffIngredients = puffPages.flatMap(item => item.ingredients);
  const puffOccurrences = puffPages.flatMap(item => item.occurrences);
  const flour = puffIngredients.find(item => item.originalText === '1 pound pastry flour');
  if (!flour)
    failures.push('Puff paste: ingredient flour line is missing');
  const puffSteps = puffOccurrences.filter(item => item.role === 'step');
  const doughIndex = puff.sourceMethods.findIndex(line => line.trim().includes('Work two tablespoons of'));
  const rollingIndex = puff.sourceMethods.findIndex(line => line.trim().includes('dredging board'));
  const doughUse = doughIndex < 0 ? undefined : puffSteps[doughIndex];
  const rollingUse = rollingIndex < 0 ? undefined : puffSteps[rollingIndex];
  if (!rollingUse)
    failures.push('Puff paste: rolling flour instruction line is missing');
  if (!doughUse)
    failures.push('Puff paste: dough flour instruction line is missing');
  if (doughUse && rollingUse) {
    if (doughUse === rollingUse || rollingIndex <= doughIndex)
      failures.push('Puff paste: dough and rolling flour instruction lines must stay separate and in order');
    if (flour && [doughUse, rollingUse].some(step => step.qualifier?.usesIngredient?.includes(flour.occurrence)))
      failures.push('Puff paste: flour instruction lines must not be linked to the ingredient occurrence');
  }

  expect(failures, failures.join('\n')).toEqual([]);
  expect(corpus.records.filter(item => item.language === 'it')).toHaveLength(10);
});

test('recipes / Catalogue browse and search in its Zone cover all 30 Works across pages', async () => {
  const pages = await readAllBrowsePages(recipeApi, corpus.realm);
  const items = pages.flatMap(page => page.items);
  expect(pages).toHaveLength(2);
  expect(items).toHaveLength(30);
  expect(pages.at(-1)?.window.complete).toBe(true);
  expect(pages.at(-1)?.matches).toEqual({ value: corpus.records.length, kind: 'exact' });
  expect(new Set(items.map(item => item.id))).toEqual(new Set(corpus.records.map(item => item.work)));
  // Title substring search for "e" matches 29 retained recipes, exceeding one page.
  const searchText = 'e';
  const expectedSearch = corpus.records.filter(item => item.title.toLowerCase().includes(searchText));
  expect(expectedSearch).toHaveLength(29);
  const search = await readAllBrowsePages(recipeApi, corpus.realm, searchText);
  const searchIds = search.flatMap(page => page.items.map(item => item.id));
  expect(search.map(page => page.items.length)).toEqual([20, 9]);
  expect(search[0]?.window.complete).toBe(false);
  expect(search[0]?.nextCursor).toBeString();
  expect(search.at(-1)?.window.complete).toBe(true);
  expect(search.at(-1)?.nextCursor).toBeNull();
  expect(search.at(-1)?.matches).toEqual({ value: expectedSearch.length, kind: 'exact' });
  expect(searchIds).toHaveLength(expectedSearch.length);
  expect(new Set(searchIds).size).toBe(searchIds.length);
  expect(new Set(searchIds)).toEqual(new Set(expectedSearch.map(item => item.work)));
});
