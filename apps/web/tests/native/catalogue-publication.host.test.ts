import { afterAll, expect, test } from 'bun:test';
import { launchPrivateBrowser, type PrivateBrowser } from './private-browser.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll } from './lifecycle.ts';

type NativeSubject = { id: string; type: string };
type CreatedInput = {
  type: string;
  labels: Record<string, string>;
  statements: Record<
    string,
    {
      value: { type: string; content?: unknown };
      references: { parts: { property: { id: string }; value: { type: string; content?: unknown } }[] }[];
    }[]
  >;
};
type PublicRead = {
  subject: {
    id: string;
    type: string;
    labels: Record<string, string>;
    statements: Record<
      string,
      {
        value: { type: string; content?: unknown };
        references: { parts: { property: { id: string }; value: { type: string; content?: unknown } }[] }[];
      }[]
    >;
  };
};

let stack: NativeWebStack;
let browser: PrivateBrowser;
const lifecycle = new NativeTestLifecycle('native catalogue publication journey');
const evidence = 'https://example.org/publication-evidence';
const statement = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
  references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: evidence } }] }],
});

async function createSubject(type: string, label: string, statements: Record<string, unknown[]> = {}) {
  const response = await stack.kernel(
    '/v1/subjects',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
      body: JSON.stringify({ type, labels: { en: label }, statements }),
    },
    'editor',
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { subject: NativeSubject }).subject;
}

async function addProgress(subjectId: string) {
  const response = await stack.kernel(
    '/v1/progressSessions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
      body: JSON.stringify({ subjectId, mode: 'scalar_amount', unit: 'page', total: '300' }),
    },
    'editor',
  );
  expect(response.status).toBe(201);
}

async function currentRequests() {
  await stack.flushKernelRequests();
  return stack.kernelRequests();
}

async function readSubject(id: string): Promise<PublicRead> {
  const response = await stack.kernel(`/v1/subjects/${encodeURIComponent(id)}`);
  expect(response.status).toBe(200);
  return (await response.json()) as PublicRead;
}

function citationPart(statement: CreatedInput['statements'][string][number], url: string) {
  expect(statement.references[0]?.parts).toContainEqual(
    expect.objectContaining({
      property: expect.objectContaining({ id: 'schema:url' }),
      value: expect.objectContaining({ type: 'value', content: url }),
    }),
  );
}

nativeBeforeAll(lifecycle, 600_000, async () => {
  stack = await startNativeWebStack();
  browser = await launchPrivateBrowser([stack.web]);
});

afterAll(async () => {
  await browser?.close();
  await stack?.stop();
}, 300_000);
nativeAfterAll(lifecycle, 300_000);

test('the production route creates Book and Anime releases, then retries only the confirmed Book read', async () => {
  const author = await createSubject('schema:Person', 'Native edition author');
  const book = await createSubject('schema:Book', 'Native edition work', {
    'schema:author': [statement('schema:author', author.id)],
    'schema:wordCount': [statement('schema:wordCount', { amount: '+120', unit: '1' })],
  });
  await addProgress(book.id);
  const movie = await createSubject('schema:Movie', 'Native animated film work');
  const start = (await currentRequests()).length;
  const credential = await stack.credentials('editor');
  if (!credential.cookie) throw new Error('The native editor has no website session cookie');
  const context = await browser.browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en' });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const webOrigin = new URL(stack.web).origin;
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== webOrigin) return route.continue();
    return route.continue({ headers: { ...route.request().headers(), cookie: credential.cookie } });
  });
  const serverFunctionHeaders: Promise<Record<string, string>>[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === webOrigin && url.pathname.startsWith('/_serverFn/') && request.method() === 'POST')
      serverFunctionHeaders.push(request.allHeaders());
  });

  const bookWorkCitation = 'https://example.org/native-book-work';
  const bookIsbnCitation = 'https://example.org/native-book-isbn';
  await page.goto(`${stack.web}/en/catalogue/publication?work=${book.id}`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.waitFor({ state: 'visible' });
  await name.fill('Native paperback edition');
  await page.getByRole('button', { name: 'Add a language', exact: true }).click();
  await page.getByRole('textbox', { name: 'Data language', exact: true }).nth(1).fill('ja');
  await page.getByRole('textbox', { name: 'Name', exact: true }).nth(1).fill('ネイティブ文庫');
  const factChoice = page.getByRole('combobox', { name: 'Add a publication fact', exact: true });
  await factChoice.selectOption('schema:isbn');
  await factChoice.locator('xpath=ancestor::fieldset[1]').getByRole('button', { name: 'Add', exact: true }).click();
  const isbn = page.locator('[data-publication-property="schema:isbn"]');
  await isbn.getByRole('textbox', { name: 'Value', exact: true }).fill('9780306406157');
  await isbn.getByRole('textbox', { name: 'URL', exact: true }).fill(bookIsbnCitation);
  await page.locator('[id$="-work-link"]').getByRole('textbox', { name: 'URL', exact: true }).fill(bookWorkCitation);
  const independent = page.getByRole('checkbox', { name: /independently identified publication/ });
  const reviewButton = page.getByRole('button', { name: 'Review publication', exact: true });
  await reviewButton.click();
  expect(await independent.getAttribute('aria-invalid')).toBe('true');
  let requests = (await currentRequests()).slice(start).filter(({ fixtureRequest }) => !fixtureRequest);
  expect(requests.some(({ method, url }) => method === 'POST' && url === '/v1/subjects')).toBe(false);

  await stack.injectCreatedSubjectReadFailureOnce({ status: 503, body: '{"title":"Temporarily unavailable"}' });
  await independent.click();
  await reviewButton.click();
  await page.getByRole('heading', { name: 'Review publication', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Edit this part' }).first().click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).first().waitFor({ state: 'visible' });
  await reviewButton.click();
  await page.getByRole('button', { name: 'Create publication', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Subject created.' }).waitFor({ state: 'visible' });
  expect(
    await page
      .getByText('The subject was created, but its ordinary reader is unavailable. Retry opening it.')
      .isVisible(),
  ).toBe(true);
  requests = (await currentRequests()).slice(start).filter(({ fixtureRequest }) => !fixtureRequest);
  const bookPost = requests.find(({ method, url }) => method === 'POST' && url === '/v1/subjects');
  expect(bookPost).toBeDefined();
  expect(bookPost!.authorization).toStartWith('Bearer ');
  expect(bookPost!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  const bookInput = JSON.parse(bookPost!.body!) as CreatedInput;
  expect(bookInput.type).toBe('bf:Instance');
  expect(bookInput.labels.en).toBe('Native paperback edition');
  expect(bookInput.labels.ja).toBe('ネイティブ文庫');
  expect(bookInput.statements['schema:exampleOfWork']?.[0]?.value.content).toBe(book.id);
  expect(bookInput.statements['schema:isbn']?.[0]?.value.content).toBe('9780306406157');
  citationPart(bookInput.statements['schema:exampleOfWork']![0]!, bookWorkCitation);
  citationPart(bookInput.statements['schema:isbn']![0]!, bookIsbnCitation);
  expect(bookInput.statements['schema:isbn']![0]!.references[0]!.parts).not.toContainEqual(
    expect.objectContaining({ value: expect.objectContaining({ content: bookWorkCitation }) }),
  );
  expect(bookInput.statements).not.toHaveProperty('schema:author');
  expect(bookInput.statements).not.toHaveProperty('schema:wordCount');
  const failedRead = requests.find(
    ({ method, url, failure }) => method === 'GET' && url.startsWith('/v1/subjects/') && failure?.status === 503,
  );
  expect(failedRead).toBeDefined();
  const bookEditionId = failedRead!.url.slice('/v1/subjects/'.length);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForURL((url) => url.pathname.includes(`/subjects/${bookEditionId}/`));
  expect(await page.getByRole('heading', { name: 'Native paperback edition', exact: true }).isVisible()).toBe(true);

  const bookEdition = await readSubject(bookEditionId);
  expect(bookEdition.subject.id).toBe(bookEditionId);
  expect(bookEdition.subject.type).toBe('bf:Instance');
  expect(bookEdition.subject.statements['schema:exampleOfWork']?.[0]?.value.content).toBe(book.id);
  expect(bookEdition.subject.statements['schema:isbn']?.[0]?.value.content).toBe('9780306406157');
  citationPart(bookEdition.subject.statements['schema:exampleOfWork']![0]!, bookWorkCitation);
  citationPart(bookEdition.subject.statements['schema:isbn']![0]!, bookIsbnCitation);
  expect(bookEdition.subject.statements).not.toHaveProperty('schema:author');
  expect(bookEdition.subject.statements).not.toHaveProperty('schema:wordCount');
  requests = (await currentRequests()).slice(start).filter(({ fixtureRequest }) => !fixtureRequest);
  expect(requests.filter(({ method, url }) => method === 'POST' && url === '/v1/subjects')).toHaveLength(1);
  expect(requests.some(({ url }) => url.startsWith('/v1/progressSessions') || url === '/v1/copies')).toBe(false);

  const movieCitation = 'https://example.org/native-film-release';
  await page.goto(`${stack.web}/en/catalogue/publication?work=${movie.id}`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Native animated release');
  await page.locator('[id$="-work-link"]').getByRole('textbox', { name: 'URL', exact: true }).fill(movieCitation);
  await page.getByRole('checkbox', { name: /independently identified publication/ }).click();
  await page.getByRole('button', { name: 'Review publication', exact: true }).click();
  await page.getByRole('button', { name: 'Create publication', exact: true }).click();
  await page.waitForURL((url) => url.pathname.includes('/subjects/'));
  const movieReleaseId = /\/subjects\/([0-9a-f-]{36})\//i.exec(new URL(page.url()).pathname)?.[1];
  expect(movieReleaseId).toBeDefined();
  expect(await page.getByRole('heading', { name: 'Native animated release', exact: true }).isVisible()).toBe(true);
  const movieRelease = await readSubject(movieReleaseId!);
  expect(movieRelease.subject.id).toBe(movieReleaseId);
  expect(movieRelease.subject.type).toBe('rezics:AnimeRelease');
  expect(movieRelease.subject.statements['schema:exampleOfWork']?.[0]?.value.content).toBe(movie.id);
  expect(movieRelease.subject.statements).not.toHaveProperty('bf:hasPart');
  expect(movieRelease.subject.statements).not.toHaveProperty('schema:inLanguage');
  citationPart(movieRelease.subject.statements['schema:exampleOfWork']![0]!, movieCitation);
  requests = (await currentRequests()).slice(start).filter(({ fixtureRequest }) => !fixtureRequest);
  expect(requests.filter(({ method, url }) => method === 'POST' && url === '/v1/subjects')).toHaveLength(2);
  const csrfHeaders = await Promise.all(serverFunctionHeaders);
  expect(csrfHeaders.some((headers) => !!headers['x-csrf-token'])).toBe(true);
});
