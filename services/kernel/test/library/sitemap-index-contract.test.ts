import { afterAll, beforeAll, expect, test } from 'bun:test';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});
test('Collection sitemap discovery has a public immutable-key index', async () => {
  const result = await db.admin.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE schemaname='library' AND tablename='collection' AND indexname='collection_sitemap_public_page'",
  );
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]!.indexdef).toContain('(route, collection_id)');
  expect(result.rows[0]!.indexdef).toContain("state = 'active'");
  expect(result.rows[0]!.indexdef).toContain("visibility = 'public'");
});
