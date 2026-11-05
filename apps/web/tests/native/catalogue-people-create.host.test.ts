import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startAuthStack } from './auth-stack.ts';
import { startNativeWebStack } from './stack.ts';

let stack: Awaited<ReturnType<typeof startNativeWebStack>>;
let auth: Awaited<ReturnType<typeof startAuthStack>>;

beforeAll(async () => {
  stack = await startNativeWebStack();
  auth = await startAuthStack(stack);
}, 300_000);

afterAll(async () => {
  await auth?.stop();
  await stack?.stop();
}, 180_000);

test('the ordinary People route creates and independently reads an Organization from released metadata', async () => {
  const journey = await auth.signIn('alice', { returnTo: '/en/catalogue/people' });
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(30_000);
  await page.locator('form').waitFor({ state: 'visible' });
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });

  const type = page.getByLabel('Type', { exact: true });
  const options = await type
    .locator('option')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
  expect(options).toContain('schema:Organization');
  await type.selectOption('schema:Organization');
  const label = `Native organization profile ${crypto.randomUUID()}`;
  await page.getByLabel('Name', { exact: true }).fill(label);
  const submit = page.getByRole('button', { name: 'Create subject', exact: true });
  await submit.click();
  await page.locator('[data-people-create-review]').waitFor({ state: 'visible' });
  await submit.click();
  await page.waitForURL((url) => url.pathname.includes('/subjects/'));
  const id = new URL(page.url()).pathname.match(/^\/en\/subjects\/([^/]+)/)?.[1];
  if (!id) throw new Error('Expected the created Organization reader URL');
  await stack.syncKernelRequests();

  const requests = stack.kernelRequests();
  const posts = requests.filter((request) => {
    if (request.method !== 'POST' || request.url !== '/v1/subjects' || !request.body) return false;
    return (JSON.parse(request.body) as { labels?: { en?: string } }).labels?.en === label;
  });
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0]!.body!)).toMatchObject({ type: 'schema:Organization', labels: { en: label } });
  expect(
    requests.some(
      (request) =>
        request.method === 'GET' &&
        request.url.split('?')[0] === `/v1/subjects/${id}` &&
        request.responseStatus === 200,
    ),
  ).toBe(true);
  await page.close();
}, 900_000);
