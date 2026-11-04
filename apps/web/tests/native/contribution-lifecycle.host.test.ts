import { afterAll, expect } from 'bun:test';
import { expect as ui } from 'playwright/test';
import { startCatalogueFactsFixture, type CatalogueFactsFixture } from './catalogue-facts-fixture.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';

const lifecycle = new NativeTestLifecycle('exact contribution lifecycle');
let fixture: CatalogueFactsFixture;
nativeBeforeAll(lifecycle, 600_000, async () => {
  fixture = await startCatalogueFactsFixture();
});
afterAll(async () => fixture?.close(), 180_000);
nativeAfterAll(lifecycle, 180_000);

nativeTest(
  'a mounted proposal result recovers its acknowledged identity beyond page twenty and changes lifecycle once',
  300_000,
  async () => {
    const subject = new URL(fixture.path, fixture.stack.web).pathname.split('/')[3]!;
    const path = `/v1/subjects/${subject}/candidates`;
    async function json(response: Response, status = 200) {
      const text = await response.text();
      expect(response.status, text).toBe(status);
      return JSON.parse(text);
    }
    async function grow() {
      for (let i = 0; i < 21; i++)
        await json(
          await fixture.stack.kernel(
            path,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
              body: JSON.stringify({
                statement: {
                  property: { id: 'schema:inLanguage' },
                  value: { type: 'value', content: 'fr' },
                  references: [
                    {
                      parts: [
                        {
                          property: { id: 'schema:url' },
                          value: { type: 'value', content: fixture.citations.language },
                        },
                      ],
                    },
                  ],
                },
              }),
            },
            'alice',
          ),
          201,
        );
    }
    await grow();
    const page = await fixture.alice.context.newPage();
    page.setDefaultTimeout(60_000);
    try {
      await page.goto(new URL(fixture.path, fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
      const field = page.getByRole('region', { name: 'language', exact: true });
      await field.getByRole('button', { name: 'Edit this field', exact: true }).click();
      await field.getByLabel('Value', { exact: true }).fill('ja');
      await fixture.stack.flushKernelRequests();
      await page.getByRole('button', { name: 'Submit included changes / retry unresolved', exact: true }).click();
      const result = field.getByRole('region', { name: 'Your contribution', exact: true });
      await ui(result.getByRole('button', { name: 'Withdraw contribution', exact: true })).toBeEnabled();
      await fixture.stack.syncKernelRequests();
      await fixture.stack.refreshKernelRequests();
      // The mounted result's first point read carries the actual proposal ACK identity.
      const first = fixture.stack
        .kernelRequests()
        .find((request) => !request.fixtureRequest && request.method === 'GET' && request.url.includes('/lifecycle?'))!;
      expect(first).toBeDefined();
      const exact = new URL(first.url, fixture.stack.kernelOrigin);
      const candidate = exact.pathname.split('/').at(-2)!;
      expect(exact.searchParams.get('property')).toBe('schema:inLanguage');
      await grow();
      const listing = await json(
        await fixture.stack.kernel(`${path}?property=schema%3AinLanguage&limit=20`, {}, 'alice'),
      );
      expect(listing.candidates.some((entry: { id: string }) => entry.id === candidate)).toBe(false);
      const before = fixture.stack.kernelRequests().length;
      await result.getByRole('button', { name: 'Read current availability', exact: true }).click();
      await ui(result.getByRole('button', { name: 'Withdraw contribution', exact: true })).toBeEnabled();
      expect(await json(await fixture.stack.kernel(exact.pathname + exact.search, {}, 'alice'))).toMatchObject({
        candidate,
        state: 'available',
        selected: false,
        actions: { operations: ['delete'] },
      });
      async function confirm(action: string) {
        await result.getByRole('button', { name: action, exact: true }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm', exact: true }).click();
      }
      await confirm('Withdraw contribution');
      await ui(result.getByRole('button', { name: 'Restore contribution', exact: true })).toBeEnabled();
      const tombstone = await json(await fixture.stack.kernel(exact.pathname + exact.search, {}, 'alice'));
      expect(tombstone).toMatchObject({
        candidate,
        state: 'deleted',
        selected: false,
        actions: { operations: ['restore'] },
      });
      for (const key of ['statement', 'payload', 'author', 'revisions']) expect(tombstone).not.toHaveProperty(key);
      await confirm('Restore contribution');
      await ui(result.getByText('Restoration confirmed', { exact: false })).toBeVisible();
      await ui(result.getByText('not currently selected', { exact: false })).toBeVisible();
      expect(await json(await fixture.stack.kernel(exact.pathname + exact.search, {}, 'alice'))).toMatchObject({
        state: 'available',
        selected: false,
      });
      expect((await fixture.current()).statements['schema:inLanguage']![0]!.value).toEqual({
        type: 'value',
        content: 'en',
      });
      await result.getByRole('button', { name: 'Read current availability', exact: true }).click();
      await ui(result.getByRole('button', { name: 'Withdraw contribution', exact: true })).toBeEnabled();
      await fixture.stack.syncKernelRequests();
      await fixture.stack.refreshKernelRequests();
      const requests = fixture.stack
        .kernelRequests()
        .slice(before)
        .filter((request) => !request.fixtureRequest);
      expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
      expect(
        requests.filter((request) => request.method === 'POST' && request.url.includes('restoreDeleted')),
      ).toHaveLength(1);
      expect(
        requests.filter(
          (request) => request.method === 'GET' && new URL(request.url, fixture.stack.kernelOrigin).pathname === path,
        ),
      ).toHaveLength(0);
      expect(requests.some((request) => request.url.includes('cursor='))).toBe(false);
    } finally {
      await page.close();
    }
  },
  lifecycle,
);
