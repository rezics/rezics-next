import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { subjectHref } from '../../src/subject/subject-href.ts';
import { startAuthStack } from './auth-stack.ts';
import { startNativeWebStack } from './stack.ts';

const minute = 'http://www.wikidata.org/entity/Q7727';
const marker = `nativerecipe${crypto.randomUUID().replaceAll('-', '').replace(/[0-9]/g, 'a')}`;
const names = {
  recipe: `${marker} stew`,
  ingredient: '200 g rice',
  corrected: '300 g rice',
  diet: `${marker} diet`,
  food: `${marker} rice grain`,
};

type PublicRead = {
  subject: {
    id: string;
    type: string;
    labels: Record<string, string>;
    statements: Record<string, { id: string; value: { type: string; content: unknown } }[]>;
  };
};

let stack: Awaited<ReturnType<typeof startNativeWebStack>>;
let auth: Awaited<ReturnType<typeof startAuthStack>>;
let dietId: string;
let foodId: string;

beforeAll(async () => {
  stack = await startNativeWebStack();
  auth = await startAuthStack(stack);
  dietId = await createSubject('skos:Concept', names.diet);
  foodId = await createSubject('wd:Q2095', names.food);
}, 300_000);

afterAll(async () => {
  await auth?.stop();
  await stack?.stop();
}, 180_000);

async function createSubject(type: string, label: string) {
  const response = await stack.kernel(
    '/v1/subjects',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
      body: JSON.stringify({ type, labels: { en: label } }),
    },
    'editor',
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { subject: { id: string } }).subject.id;
}

async function publicRead(id: string): Promise<PublicRead> {
  const response = await stack.kernel(`/v1/subjects/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as PublicRead;
}

async function candidates(id: string, property: string) {
  const response = await stack.kernel(
    `/v1/subjects/${id}/candidates?property=${encodeURIComponent(property)}`,
    {},
    'alice',
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    candidates: { id: string; statement: { value: { content: unknown } }; decision: unknown }[];
  };
}

async function recipePosts(label: string) {
  await stack.syncKernelRequests();
  return stack.kernelRequests().filter((request) => {
    if (request.method !== 'POST' || request.url !== '/v1/subjects' || request.fixtureRequest || !request.body)
      return false;
    const body = JSON.parse(request.body) as { type?: string; labels?: { en?: string } };
    return body.type === 'schema:Recipe' && body.labels?.en === label;
  });
}

function candidatePosts(id: string) {
  return stack
    .kernelRequests()
    .filter(
      (request) =>
        request.method === 'POST' && request.url === `/v1/subjects/${id}/candidates` && !request.fixtureRequest,
    );
}

function draft(page: Page, name: string) {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name, exact: true, level: 2 }) })
    .filter({ has: page.locator('fieldset') });
}

async function addFact(page: Page, property: string) {
  await page.getByRole('combobox', { name: 'Add fact' }).selectOption(property);
  await page.getByRole('button', { name: /^Add$/ }).click();
}

async function waitForSuggestion(label: string, type: string) {
  const until = performance.now() + 30_000;
  while (performance.now() < until) {
    const response = await stack.kernel(`/v1/subjects:suggest?q=${encodeURIComponent(label)}&languages=en`);
    if (response.status === 404 || response.status === 403) return null;
    if (response.status === 200) {
      const body = (await response.json()) as { subjects?: { id: string; type: string; labels?: { en?: string } }[] };
      const hit = body.subjects?.find((subject) => subject.labels?.en === label && subject.type === type);
      if (hit) return hit;
    }
    await Bun.sleep(200);
  }
  return null;
}

async function pickTarget(page: Page, section: ReturnType<typeof draft>, label: string, title: string) {
  const box = section.getByRole('combobox', { name: label });
  await box.fill(title);
  const option = page.getByRole('option', { name: title });
  await option.waitFor({ state: 'visible', timeout: 20_000 });
  await option.click();
}

test('native Recipe website creation selects structured facts; later per-field corrections stay unpublished until selection', async () => {
  const [dietHit, foodHit] = await Promise.all([
    waitForSuggestion(names.diet, 'skos:Concept'),
    waitForSuggestion(names.food, 'wd:Q2095'),
  ]);
  const journey = await auth.signIn('alice', { returnTo: '/en/catalogue/recipe' });
  expect(journey.url).toBe(`${stack.web}/en/catalogue/recipe`);
  expect((await journey.response()).status()).toBe(200);

  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(30_000);
  const browserHeaders: Promise<Headers>[] = [];
  page.on('request', (request) => {
    browserHeaders.push(request.allHeaders().then((headers) => new Headers(headers)));
  });

  await page.locator('form').waitFor({ state: 'visible' });
  const offered = await page
    .getByRole('combobox', { name: 'Add fact' })
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  expect(offered).toEqual(expect.arrayContaining(['schema:recipeIngredient', 'wdt:P186', 'schema:suitableForDiet']));
  expect(new Set(offered).size).toBe(offered.length);

  await page.getByRole('textbox', { name: 'Name' }).fill(names.recipe);

  await addFact(page, 'schema:recipeIngredient');
  const ingredient = draft(page, 'ingredient');
  await ingredient.getByRole('textbox', { name: 'Value' }).fill(names.ingredient);
  await ingredient.getByRole('textbox', { name: 'Value language' }).fill('en');

  await addFact(page, 'schema:cookTime');
  const cookTime = draft(page, 'cooking time');
  await cookTime.getByRole('textbox', { name: 'Amount' }).fill('+25');
  await cookTime.getByRole('combobox', { name: 'Unit' }).selectOption(minute);

  if (dietHit) {
    await addFact(page, 'schema:suitableForDiet');
    await pickTarget(page, draft(page, 'suitable for diet'), 'suitable for diet', names.diet);
  }
  if (foodHit) {
    await addFact(page, 'wdt:P186');
    await pickTarget(page, draft(page, 'made from material'), 'made from material', names.food);
  }

  await page.getByRole('button', { name: 'Review this recipe' }).click();
  await page.locator('form button[type="submit"]').click();
  await page
    .getByRole('status')
    .filter({ hasText: /created/i })
    .waitFor({ state: 'visible' });
  const publicHref = await page.getByRole('link', { name: 'View public subject' }).getAttribute('href');
  const id = publicHref?.match(/\/subjects\/([^/]+)/)?.[1];
  expect(id).toBeTruthy();

  const posts = await recipePosts(names.recipe);
  expect(posts).toHaveLength(1);
  expect(posts[0]?.responseStatus).toBe(201);
  const created = JSON.parse(posts[0]!.body!) as {
    type: string;
    labels: { en: string };
    statements: Record<string, { property: { id: string }; value: { content: unknown } }[]>;
  };
  expect(created.type).toBe('schema:Recipe');
  expect(created.statements['schema:recipeIngredient']![0]).toMatchObject({
    property: { id: 'schema:recipeIngredient' },
    value: { content: { language: 'en', text: names.ingredient } },
  });
  expect(created.statements['schema:cookTime']![0]).toMatchObject({
    property: { id: 'schema:cookTime' },
    value: { content: { amount: '+25', unit: minute } },
  });
  expect(created.statements['schema:recipeIngredient']![0]!.property.id).not.toBe('wdt:P186');
  expect(created.statements['schema:recipeIngredient']![0]!.property.id).not.toBe('schema:suitableForDiet');
  if (dietHit) {
    expect(created.statements['schema:suitableForDiet']![0]!.value.content).toBe(dietId);
    expect(created.statements['schema:suitableForDiet']![0]!.value.content).not.toBe(
      created.statements['schema:recipeIngredient']![0]!.value.content,
    );
  }
  if (foodHit) expect(created.statements['wdt:P186']![0]!.value.content).toBe(foodId);

  const selected = await publicRead(id!);
  expect(selected.subject.type).toBe('schema:Recipe');
  expect(selected.subject.labels.en).toBe(names.recipe);
  expect(selected.subject.statements['schema:recipeIngredient']![0]!.value.content).toEqual({
    language: 'en',
    text: names.ingredient,
  });
  expect(selected.subject.statements['schema:cookTime']![0]!.value.content).toEqual({
    amount: '+25',
    unit: minute,
  });
  if (dietHit) expect(selected.subject.statements['schema:suitableForDiet']![0]!.value.content).toBe(dietId);
  if (foodHit) expect(selected.subject.statements['wdt:P186']![0]!.value.content).toBe(foodId);

  const editor = `${stack.web}${subjectHref({ id: id!, label: names.recipe }, 'en').href}/recipe`;
  await page.goto(editor, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Correct recipe' }).waitFor({ state: 'visible' });

  await page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'cooking time', exact: true }) })
    .getByRole('button', { name: 'Propose a correction' })
    .click();
  const cookCorrection = draft(page, 'cooking time');
  await cookCorrection.getByRole('textbox', { name: 'Amount' }).fill('+40');
  await cookCorrection.getByRole('button', { name: 'Review this recipe' }).click();
  await cookCorrection.getByRole('button', { name: 'Submit proposal' }).click();
  await cookCorrection
    .getByRole('status')
    .filter({ hasText: /awaiting review/i })
    .waitFor({ state: 'visible' });

  await page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'ingredient', exact: true }) })
    .getByRole('button', { name: 'Propose a correction' })
    .first()
    .click();
  const ingredientCorrection = draft(page, 'ingredient');
  await ingredientCorrection.getByRole('textbox', { name: 'Value' }).fill(names.corrected);
  await ingredientCorrection.getByRole('button', { name: 'Review this recipe' }).click();

  let dropped: { status: number; body: string } | undefined;
  const dropFirst = async (route: import('playwright').Route) => {
    if (!dropped && route.request().method() === 'POST') {
      const response = await route.fetch();
      dropped = { status: response.status(), body: await response.text() };
      await route.abort('failed');
      return;
    }
    await route.continue();
  };
  await page.route('**/_serverFn/**', dropFirst);
  await ingredientCorrection.getByRole('button', { name: 'Submit proposal' }).click();
  await ingredientCorrection.getByRole('button', { name: 'Retry exact proposal' }).waitFor({ state: 'visible' });
  await cookCorrection
    .getByRole('status')
    .filter({ hasText: /awaiting review/i })
    .waitFor({ state: 'visible' });
  await ingredientCorrection.getByRole('button', { name: 'Retry exact proposal' }).click();
  await ingredientCorrection
    .getByRole('status')
    .filter({ hasText: /awaiting review/i })
    .waitFor({ state: 'visible' });
  await page.unroute('**/_serverFn/**', dropFirst);
  expect(dropped?.status).toBe(201);

  await stack.syncKernelRequests();
  const proposals = candidatePosts(id!);
  expect(proposals.map((request) => request.responseStatus)).toEqual([201, 201, 201]);
  expect(proposals[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(proposals[1]?.idempotencyKey).toBe(proposals[2]?.idempotencyKey);
  expect(proposals[1]?.idempotencyKey).not.toBe(proposals[0]?.idempotencyKey);
  expect(proposals.every((request) => request.authorization?.startsWith('Bearer '))).toBe(true);

  const current = await publicRead(id!);
  expect(current.subject.statements['schema:cookTime']![0]!.value.content).toEqual({
    amount: '+25',
    unit: minute,
  });
  expect(current.subject.statements['schema:recipeIngredient']![0]!.value.content).toEqual({
    language: 'en',
    text: names.ingredient,
  });

  const cookCandidates = await candidates(id!, 'schema:cookTime');
  const ingredientCandidates = await candidates(id!, 'schema:recipeIngredient');
  expect(
    cookCandidates.candidates.some(
      (row) => JSON.stringify(row.statement.value.content) === JSON.stringify({ amount: '+40', unit: minute }),
    ),
  ).toBe(true);
  expect(cookCandidates.candidates.every((row) => row.decision == null)).toBe(true);
  expect(
    ingredientCandidates.candidates.some(
      (row) =>
        JSON.stringify(row.statement.value.content) === JSON.stringify({ language: 'en', text: names.corrected }),
    ),
  ).toBe(true);
  expect(ingredientCandidates.candidates).toHaveLength(1);

  const allBrowserHeaders = await Promise.all(browserHeaders);
  expect(allBrowserHeaders.every((headers) => !headers.has('authorization'))).toBe(true);
}, 900_000);
