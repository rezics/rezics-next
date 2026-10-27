import { afterAll, beforeAll, expect, test } from 'bun:test';
import { openApiDocument } from '../../src/http/openapi.ts';
import { testKernel } from '../support/test-kernel.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
let app: ReturnType<typeof testKernel>;
beforeAll(async () => {
  db = await openGrowthDatabase();
  app = testKernel({ pool: db.pool });
});
afterAll(async () => {
  await db?.close();
});

test('the Collection sitemap is a public anonymous feed', async () => {
  const operation = openApiDocument(app).paths['/v1/sitemap/collections']?.get;
  expect(operation).toBeDefined();
  expect(operation?.['x-exposure']).toBe('public');
  const response = await app.handle(new Request('https://kernel.test/v1/sitemap/collections?limit=1'));
  expect(response.status).toBe(200);
  const page = (await response.json()) as { items: unknown[]; next: string | null };
  expect(Object.keys(page).sort()).toEqual(['items', 'next']);
  expect(page.items).toEqual([]);
  expect(page.next === null || typeof page.next === 'string').toBe(true);
});

test('the Collection sitemap rejects an invalid cursor', async () => {
  const response = await app.handle(new Request('https://kernel.test/v1/sitemap/collections?cursor=forged'));
  expect(response.status).toBe(400);
  const problem = (await response.json()) as { code: string };
  expect(problem.code).toBe('invalid_cursor');
});
