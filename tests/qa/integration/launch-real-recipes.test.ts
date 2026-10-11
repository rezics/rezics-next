import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { join } from 'node:path';
import { readEnv } from '../../../scripts/dev/config.ts';
import { root } from '../../../scripts/fixture/stack.ts';
import { createCorpusBackupDriver, type CorpusRestoreSmokeInput } from '../../../scripts/load/corpus-backup-driver.ts';
import { grantLaunchRecipeAuthority, launchRecipeSources, prepareLaunchRecipesCorpus,
  restoreLaunchRecipesCorpus, type LaunchRecipesCorpus }
  from '../../../scripts/load/launch-corpus.ts';
import { workProfileCorpusApi, type CorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
import { initializeRelayCheckpoint } from '../../../services/main/src/modules/outbox/relay.ts';
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

async function importFile(stack: MediaStack, token: string, actor: string, key: string,
  composition: { structure: string; revision: string }, file: Record<string, unknown>, signal: AbortSignal) {
  const path = `/v1/recipes/${short(composition.structure)}/file-imports`
    + `?actingSubject=${encodeURIComponent(actor)}&expectedHead=${encodeURIComponent(composition.revision)}`;
  const response = await stack.main.handle(new Request(`http://main.local${path}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
      'content-type': 'application/ld+json' }, body: JSON.stringify(file), signal }));
  if (![200, 201].includes(response.status)) {
    throw new Error(`Recipe file import returned HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json() as { structure: string; revision: string; sourceObservation: string; replayed: boolean };
}

async function openCopy(input: CorpusRestoreSmokeInput) {
  const env = { ...input.apps, REZICS_QA_RUN_ID: input.runId, REZICS_QA_STACK_MODE: 'scale',
    REZICS_QA_STACK_TIER: 'integration', REZICS_STACK_PROFILE: 'qa' };
  const previous = new Map(Object.keys(env).map(key => [key, Bun.env[key]]));
  Object.assign(Bun.env, env);
  try {
    const stack = await startMediaStack('launch-recipes-restored', { library: true, ownerUrls: {
      access: input.apps.ACCESS_DATABASE_URL!, content: input.apps.CONTENT_DATABASE_URL!,
      relay: input.apps.ACCOUNT_RELAY_DATABASE_URL!,
    } });
    const workObjects = stack.objects('semantic/work/');
    const structureObjects = stack.objects('semantic/structure/');
    await Promise.all([workObjects.initialize(), structureObjects.initialize()]);
    Object.assign(stack.env, { objectDirectory: input.apps.MAIN_OBJECT_DIRECTORY!, workObjects, structureObjects });
    return stack;
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
  items: { id: string; title: { value: string } }[];
  nextCursor: string | null;
}

let corpus: LaunchRecipesCorpus;
let recipeApi: CorpusApi;
let recipeActor = '';
const copies = new Map<string, MediaStack>();
const targets = ['one', 'two'] as const;
let driver: ReturnType<typeof createCorpusBackupDriver>;
let source: MediaStack | undefined;
let relay: Pool | undefined;
let relayClosed = false;
let sourceClosed = false;

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
  source = await startMediaStack('launch-recipes-source', { library: true, profileCredits: true });
  relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  driver = createCorpusBackupDriver({ sourceRunId,
    directory: join(root, '.temp/launch-corpus/recipes/backups'), resumeSource: false,
    async quiesce(signal) {
      signal.throwIfAborted();
      await relay!.end();
      relayClosed = true;
      await source!.stop();
      sourceClosed = true;
    },
    async smokeRead(input) {
      const stack = await openCopy(input);
      try {
        const importer = await stack.member('launch-recipes-importer', { stable: true, verified: true });
        const api = apiFor(stack, importer.token);
        const pathFor = (cursor?: string) => {
          const query = new URLSearchParams({ limit: '20', language: 'en' });
          if (cursor) query.set('cursor', cursor);
          return `/v1/realms/${short(corpus.realm)}/modules/browse?${query}` as const;
        };
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await api.read<ZoneBrowsePage>(pathFor(cursor));
          ids.push(...page.items.map(item => item.id));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(new Set(ids)).toEqual(new Set(corpus.records.map(item => item.work)));
        copies.set(input.target, stack);
        return async () => { copies.delete(input.target); await stack.stop(); };
      } catch (error) {
        await stack.stop();
        throw error;
      }
    },
  });
  const importer = await source.member('launch-recipes-importer', { stable: true, verified: true });
  recipeActor = importer.actor;
  await initializeRelayCheckpoint(relay, Bun.env.MAIN_RELAY_CONSUMER!, source.env.lineage.dataEpoch);
  const api = apiFor(source, importer.token);
  corpus = await prepareLaunchRecipesCorpus({ api, actor: importer.actor, backups: driver,
    directory: join(root, '.temp/launch-corpus/recipes/manifests'),
    authorize: (scope, action) => grantLaunchRecipeAuthority(source!.accessPool,
      importer.principalId, importer.actor, scope, action),
    importFile: (key, actor, composition, file, signal) => importFile(source!, importer.token,
      actor, key, composition, file, signal),
  });
  expect(corpus.counts).toEqual({ works: 30, recipes: 30, ingredientLines: 173, fractionLines: 47,
    rangeLines: 2, englishRecipes: 20, italianRecipes: 10 });
  expect(corpus.records).toHaveLength(30);
  expect(corpus.buildMs).toBeLessThan(600_000);
  for (const target of targets) expect(await restoreLaunchRecipesCorpus(corpus, `launch-recipes-${sourceRunId}-${target}`, driver))
    .toBeLessThan(600_000);
  const restored = copies.get(`launch-recipes-${sourceRunId}-one`)!;
  recipeApi = apiFor(restored, (await restored.member('launch-recipes-importer', { stable: true, verified: true })).token);
}, 600_000);

afterAll(async () => {
  const failures: unknown[] = [];
  for (const target of targets) {
    try { await driver?.stop(`launch-recipes-${Bun.env.REZICS_QA_RUN_ID}-${target}`); }
    catch (error) { failures.push(error); }
  }
  if (!relayClosed && relay) { try { await relay.end(); } catch (error) { failures.push(error); } }
  if (!sourceClosed && source) { try { await source.stop(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, 'Launch recipe corpus cleanup failed');
});

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
    const query = new URLSearchParams({ limit: '20', language: 'en' });
    if (q) query.set('q', q);
    if (cursor) query.set('cursor', cursor);
    const page = await api.read<ZoneBrowsePage>(`/v1/realms/${short(realm)}/modules/browse?${query}`);
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return pages;
}

test('recipes / Pinned Schema.org imports retain ordered content and expose quantity parser gaps', async () => {
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
  for (const row of quantities) {
    const actual = row.ingredients[row.index];
    if (/[½¼¾⅓⅔⅛⅜⅝⅞]/u.test(row.line) && !actual?.amount)
      failures.push(`${row.record.title}: fraction has no parsed amount (${row.line})`);
    if (/\b\d+\s+(?:to|or)\s+\d+\b/iu.test(row.line)
      && (!actual?.amount || !actual.amountUpper))
      failures.push(`${row.record.title}: range is not retained as lower and upper quantities (${row.line})`);
  }

  const puff = corpus.records.find(item => item.recipeId === 'puff-paste')!;
  const puffPages = recipePages.get(puff.work)!;
  const puffIngredients = puffPages.flatMap(item => item.ingredients);
  const puffOccurrences = puffPages.flatMap(item => item.occurrences);
  const flour = puffIngredients.find(item => item.originalText === '1 pound pastry flour');
  if (!flour)
    failures.push('Puff paste: ingredient flour line is missing');
  const doughUse = puffOccurrences.find(item => item.role === 'step'
    && item.qualifier?.instructionText?.value.startsWith('Work two tablespoons of butter into flour'));
  const rollingUse = puffOccurrences.find(item => item.role === 'step'
    && item.qualifier?.instructionText?.value.includes('dredging board slightly with flour when necessary'));
  if (!rollingUse)
    failures.push('Puff paste: rolling flour instruction line is missing');
  if (flour && (!doughUse?.qualifier?.usesIngredient?.includes(flour.occurrence)
    || !rollingUse?.qualifier?.usesIngredient?.includes(flour.occurrence)))
    failures.push('Puff paste: the dough and rolling stages do not both retain their flour use');

  expect(failures, failures.join('\n')).toEqual([]);
  expect(corpus.records.filter(item => item.language === 'it')).toHaveLength(10);
});

test('recipes / Catalogue browse and search in its Zone cover all 30 Works across pages', async () => {
  const pages = await readAllBrowsePages(recipeApi, corpus.realm);
  const items = pages.flatMap(page => page.items);
  expect(pages).toHaveLength(2);
  expect(items).toHaveLength(30);
  expect(new Set(items.map(item => item.id))).toEqual(new Set(corpus.records.map(item => item.work)));
  const search = await readAllBrowsePages(recipeApi, corpus.realm, 'Puff Paste');
  expect(search.flatMap(page => page.items).map(item => item.id)).toContain(
    corpus.records.find(item => item.recipeId === 'puff-paste')!.work);
});
