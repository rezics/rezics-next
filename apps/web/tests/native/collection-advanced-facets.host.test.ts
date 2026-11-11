import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { m } from '../../src/paraglide/messages.js';
import {
  startNativeCuratedCollectionsFixture,
  type NativeCuratedCollectionsFixture,
} from './native-curated-collections-fixture.ts';

setDefaultTimeout(900_000);

let fixture: NativeCuratedCollectionsFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const requestKey = () => JSON.stringify(crypto.randomUUID());
const facetPath = '/v1/subjects:facets';

function statement(property: string, content: string) {
  return {
    property: { id: property },
    value: { type: 'value', content },
    references: [
      {
        parts: [
          {
            property: { id: 'schema:url' },
            value: { type: 'value', content: `https://example.org/collection-facets/${crypto.randomUUID()}` },
          },
        ],
      },
    ],
  };
}

async function collectionId(response: Response, expectedStatus: number, action: string): Promise<string> {
  const body = await response.text();
  expect(response.status, `${action}: ${body}`).toBe(expectedStatus);
  return (JSON.parse(body) as { collection: { id: string } }).collection.id;
}

async function latestFacetRequest(): Promise<{ body: Record<string, unknown>; responseStatus: number | undefined }> {
  await fixture!.stack.flushKernelRequests();
  const request = [...fixture!.stack.kernelRequests()]
    .reverse()
    .find(({ method, url }) => method === 'POST' && url.startsWith(facetPath));
  expect(request?.body).toBeDefined();
  return {
    body: JSON.parse(request!.body!) as Record<string, unknown>,
    responseStatus: request!.responseStatus,
  };
}

async function openGenreValues(page: Awaited<ReturnType<NativeCuratedCollectionsFixture['page']>>) {
  await page.getByRole('button', { name: m.collection_filters() }).click();
  const dialog = page.getByRole('dialog', { name: m.collection_filters() });
  await dialog.getByRole('combobox', { name: m.refinement_property() }).click();
  await page.getByRole('option', { name: 'Genre', exact: true }).click();
  const values = dialog.locator('input[type="checkbox"][name="f.schema:genre"]');
  await values.first().waitFor({ state: 'visible', timeout: 120_000 });
  return { dialog, values };
}

test('default Collection reader pages exact native facets for curated and saved dynamic Collections', async () => {
  fixture = await startNativeCuratedCollectionsFixture();
  const concepts = await Promise.all(
    Array.from({ length: 14 }, (_, index) =>
      fixture!.createSubject(`Facet concept ${String(index).padStart(2, '0')}`, { type: 'skos:Concept' }),
    ),
  );
  const keyword = concepts[0]!;
  const form = concepts[1]!;
  const genres = concepts.slice(2);
  const books = await Promise.all(
    genres.map((genre, index) =>
      fixture!.createSubject(`Facet Book ${String(index).padStart(2, '0')}`, {
        statements: {
          'schema:keywords': [statement('schema:keywords', keyword.id)],
          'wdt:P7937': [statement('wdt:P7937', form.id)],
          'schema:genre': [statement('schema:genre', genre.id)],
        },
      }),
    ),
  );
  const appliedRule = {
    and: [
      { type: { in: ['schema:Book'] } },
      { statement: { property: 'schema:keywords', in: [keyword.id] } },
      { statement: { property: 'wdt:P7937', in: [form.id] } },
    ],
  };

  const curatedId = await collectionId(
    await fixture.stack.kernel(
      '/v1/collections',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': requestKey() },
        body: JSON.stringify({ title: `Facet shelf ${crypto.randomUUID()}`, visibility: 'public' }),
      },
      'alice',
    ),
    201,
    'Create public curated Collection',
  );
  for (const book of books.slice(0, 11)) {
    const response = await fixture.stack.kernel(
      `/v1/collections/${encodeURIComponent(curatedId)}/members`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': requestKey() },
        body: JSON.stringify({ subjectId: book.id }),
      },
      'alice',
    );
    expect(response.status, await response.text()).toBe(201);
  }
  const dynamicId = await collectionId(
    await fixture.stack.kernel(
      '/v1/collections',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': requestKey() },
        body: JSON.stringify({
          title: `Facet rule ${crypto.randomUUID()}`,
          visibility: 'private',
          membershipKind: 'dynamic',
          rule: { filter: appliedRule, sort: 'id' },
        }),
      },
      'alice',
    ),
    201,
    'Create private saved dynamic Collection',
  );

  const address = (id: string, unmatched = false) => {
    const search = new URLSearchParams({ type: 'schema:Book' });
    search.append('f.schema:keywords', unmatched ? crypto.randomUUID() : keyword.id);
    search.append('f.wdt:P7937', form.id);
    return `/en/collections/${encodeURIComponent(id)}?${search}`;
  };
  const anonymousPage = await fixture.page('anonymous');
  await anonymousPage.goto(new URL(address(curatedId), fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
  await anonymousPage.locator('html[data-hydrated]').waitFor();
  const curated = await openGenreValues(anonymousPage);
  const firstPage = await curated.values.evaluateAll((inputs) =>
    inputs.map((input) => (input as HTMLInputElement).value),
  );
  expect(firstPage).toHaveLength(10);
  const request = await latestFacetRequest();
  expect(request.body.scope).toEqual({ kind: 'collection', id: curatedId });
  expect(request.body.facets).toEqual([{ property: 'schema:genre', size: 10 }]);
  const applied = JSON.stringify(request.body.filter);
  expect(applied).toContain('schema:Book');
  expect(applied).toContain(keyword.id);
  expect(applied).toContain(form.id);
  expect(await curated.dialog.getByText(/count/i).count()).toBe(0);

  const selected = firstPage[0]!;
  await curated.values.first().check();
  await curated.dialog.getByRole('button', { name: m.refinement_more_values() }).click();
  await curated.values.last().waitFor({ state: 'visible' });
  const secondPage = await curated.values.evaluateAll((inputs) =>
    inputs.map((input) => (input as HTMLInputElement).value),
  );
  const visibleValues = new Set([...firstPage, ...secondPage]);
  expect(visibleValues).toEqual(new Set(genres.slice(0, 11).map(({ id }) => id)));
  expect(visibleValues.has(genres[11]!.id)).toBe(false);
  await Promise.all([
    anonymousPage.waitForURL((url) => url.searchParams.get('f.schema:genre') === selected),
    curated.dialog.getByRole('button', { name: m.collection_filter_apply() }).click(),
  ]);
  const curatedApplied = new URL(anonymousPage.url());
  expect(curatedApplied.searchParams.get('type')).toBe('schema:Book');
  expect(curatedApplied.searchParams.get('f.schema:keywords')).toBe(keyword.id);
  expect(curatedApplied.searchParams.get('f.wdt:P7937')).toBe(form.id);

  const ownerPage = await fixture.page('alice');
  await ownerPage.goto(new URL(address(dynamicId), fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
  await ownerPage.locator('html[data-hydrated]').waitFor();
  const dynamic = await openGenreValues(ownerPage);
  expect(await dynamic.values.count()).toBeGreaterThan(0);
  const dynamicRequest = await latestFacetRequest();
  expect(dynamicRequest.body.scope).toEqual({ kind: 'collection', id: dynamicId });
  const dynamicFilter = JSON.stringify(dynamicRequest.body.filter);
  expect(dynamicFilter).toContain(keyword.id);
  expect(dynamicFilter).toContain(form.id);
  await ownerPage.getByRole('button', { name: m.saved_filter_review_open() }).click();
  await ownerPage.getByRole('button', { name: m.saved_filter_review_value_labels() }).click();
  await ownerPage.getByText(m.saved_filter_review_value_labels_ready()).waitFor();
  expect(await ownerPage.getByText(keyword.id, { exact: true }).count()).toBeGreaterThan(0);
  expect(await ownerPage.getByText(form.id, { exact: true }).count()).toBeGreaterThan(0);
  const reviewRequest = await latestFacetRequest();
  expect(reviewRequest.body.scope).toEqual({ kind: 'collection', id: dynamicId });
  expect(reviewRequest.body.facets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ property: 'schema:keywords', size: 20 }),
      expect.objectContaining({ property: 'wdt:P7937', size: 20 }),
    ]),
  );

  const emptyAddress = address(curatedId, true);
  await anonymousPage.goto(new URL(emptyAddress, fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
  await anonymousPage.locator('html[data-hydrated]').waitFor();
  const empty = await openGenreValues(anonymousPage);
  await empty.dialog.getByText(m.refinement_no_values()).waitFor();
  expect(await empty.dialog.getByText(m.search_reader_facets_not_ready()).count()).toBe(0);
  await fixture.stack.flushKernelRequests();
  expect((await latestFacetRequest()).responseStatus).toBe(200);

  const dynamicRequestBody = dynamicRequest.body;
  const refused = await fixture.stack.kernel(
    facetPath,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...dynamicRequestBody, scope: { kind: 'collection', id: dynamicId } }),
    },
    'bob',
  );
  expect([403, 404]).toContain(refused.status);
  expect(await refused.json()).not.toHaveProperty('facets');
});
