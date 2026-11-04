import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { expect as ui } from 'playwright/test';
import { catalogueEntries } from '../../src/features/catalogue/catalogue-entry.ts';
import { subjectHref } from '../../src/subject/subject-href.ts';
import {
  startCatalogueClassificationFixture,
  type NativeClassificationFixture,
} from './catalogue-classification-fixture.ts';

setDefaultTimeout(900_000);

let fixture: NativeClassificationFixture;

beforeAll(async () => {
  fixture = await startCatalogueClassificationFixture();
}, 600_000);

afterAll(async () => fixture?.close(), 180_000);

function statement(property: string, dataType: string, content: string) {
  return {
    property: { id: property, data_type: dataType },
    value: { type: 'value', content },
    qualifiers: [],
    references: [],
    rank: 'normal',
  };
}

async function createSourceSubject(
  type: 'skos:Concept' | 'skos:ConceptScheme',
  label: string,
  statements: Record<string, ReturnType<typeof statement>[]> = {},
) {
  const response = await fixture.stack.kernel(
    '/v1/subjects',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
      body: JSON.stringify({ type, labels: { en: label }, ...(Object.keys(statements).length ? { statements } : {}) }),
    },
    'editor',
  );
  const text = await response.text();
  expect(response.status).toBe(201);
  return (JSON.parse(text) as { subject: { id: string } }).subject.id;
}

async function hydrate(page: import('playwright').Page) {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

test('mounted source Concept visit reads native identity and hierarchy, recovers the exact cursor, and returns to its classification', async () => {
  const marker = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const schemeLabel = `Native scheme ${marker}`;
  const parentLabel = `Native broader ${marker}`;
  const sourceLabel = `Native source concept ${marker}`;
  const scheme = await createSourceSubject('skos:ConceptScheme', schemeLabel);
  const membership = { 'skos:inScheme': [statement('skos:inScheme', 'wikibase-item', scheme)] };
  const parent = await createSourceSubject('skos:Concept', parentLabel, membership);
  const source = await createSourceSubject('skos:Concept', sourceLabel, {
    ...membership,
    'skos:broader': [statement('skos:broader', 'wikibase-item', parent)],
    'wdt:P3180': [statement('wdt:P3180', 'external-id', `v${100000 + Math.floor(Math.random() * 800000)}`)],
  });
  const children: string[] = [];
  for (let index = 0; index < 21; index++) {
    children.push(
      await createSourceSubject('skos:Concept', `Native narrower ${marker} ${index}`, {
        ...membership,
        'skos:broader': [statement('skos:broader', 'wikibase-item', source)],
      }),
    );
  }

  const sourceRead = await fixture.stack.kernel(`/v1/subjects/${source}`);
  expect(sourceRead.status).toBe(200);
  const native = (await sourceRead.json()) as {
    subject: { id: string; statements: Record<string, { id: string; value: { content: unknown } }[]> };
  };
  expect(native.subject.id).toBe(source);
  expect(native.subject.statements['skos:inScheme']?.[0]?.value.content).toBe(scheme);
  expect(native.subject.statements['skos:broader']?.[0]?.value.content).toBe(parent);
  expect(native.subject.statements['wdt:P3180']?.[0]?.value.content).toMatch(/^v[1-9][0-9]*$/);
  const linkRead = await fixture.stack.kernel(`/v1/subjects/${source}/links?property=skos:broader&limit=20&language=en`);
  expect(linkRead.status).toBe(200);
  const nativeLinks = (await linkRead.json()) as {
    links: { subject: string; property: string; statement: string }[];
    next: string | null;
  };
  expect(nativeLinks.links).toHaveLength(20);
  expect(nativeLinks.links.every((row) => row.property === 'skos:broader')).toBe(true);
  expect(nativeLinks.links.every((row) => children.includes(row.subject) && row.statement)).toBe(true);
  expect(nativeLinks.next).toBeTruthy();

  const origin = catalogueEntries.graph({ id: fixture.manga.id, label: fixture.manga.label, locale: 'en' }).href;
  const path = catalogueEntries.concepts({ id: source, label: sourceLabel, locale: 'en' }).href;
  const address = `${path}?${new URLSearchParams({ returnTo: origin, pin: 'sha256:requested-historical-pin' })}`;
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);
  await fixture.stack.injectKernelFailureOnce({
    method: 'GET',
    path: `/v1/subjects/${source}/links`,
    status: 503,
    body: JSON.stringify({ title: 'Temporary links failure', status: 503, code: 'dependency_unavailable' }),
  });
  const opened = await page.goto(new URL(address, fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
  expect(opened?.status()).toBe(200);
  await hydrate(page);
  await ui(page.getByText(source, { exact: false })).toBeVisible();
  await ui(page.getByText('A historical source pin was requested', { exact: false })).toBeVisible();
  await ui(page.getByRole('link', { name: 'Correct this fact', exact: true })).toBeVisible();
  const hierarchy = page.locator('section[aria-labelledby="concept-narrower-heading"]');
  await ui(hierarchy.getByRole('alert')).toBeVisible();
  await hierarchy.getByRole('button', { name: 'Retry this page', exact: true }).click();
  await ui(hierarchy.getByRole('link', { name: new RegExp(`Native narrower ${marker}`) }).first()).toBeVisible({ timeout: 60_000 });
  await ui(hierarchy.getByRole('button', { name: 'More hierarchy', exact: true })).toBeEnabled();
  const firstPageLabels = await hierarchy.getByRole('link', { name: new RegExp(`Native narrower ${marker}`) }).allTextContents();

  await fixture.stack.injectKernelFailureOnce({
    method: 'GET',
    path: `/v1/subjects/${source}/links`,
    status: 503,
    body: JSON.stringify({ title: 'Temporary links failure', status: 503, code: 'dependency_unavailable' }),
  });
  await hierarchy.getByRole('button', { name: 'More hierarchy', exact: true }).click();
  await ui(hierarchy.getByRole('alert')).toBeVisible();
  expect(await hierarchy.getByRole('link', { name: new RegExp(`Native narrower ${marker}`) }).allTextContents()).toEqual(firstPageLabels);
  const linkRequests = () =>
    fixture.stack
      .kernelRequests()
      .filter((request) => request.method === 'GET' && new URL(request.url, fixture.stack.kernelOrigin).pathname === `/v1/subjects/${source}/links`)
      .map((request) => new URL(request.url, fixture.stack.kernelOrigin).searchParams.get('cursor'));
  const failedCursor = linkRequests().at(-1);
  expect(failedCursor).toBeTruthy();
  await hierarchy.getByRole('button', { name: 'Retry this page', exact: true }).click();
  expect(linkRequests().at(-1)).toBe(failedCursor);
  await ui(hierarchy.getByRole('button', { name: 'Previous page', exact: true })).toBeEnabled();
  await page.getByRole('link', { name: 'Return to the selected fact', exact: true }).click();
  expect(new URL(page.url()).pathname).toBe(new URL(origin, fixture.stack.web).pathname);
  await page.close();
});
