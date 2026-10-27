import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { readPreparationNativeHeader } from '../../src/library/preparation-native-reader.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});
test('native preparation header rejects missing evidence and copied receipt namespaces', async () => {
  const route = 0x6a10,
    accountId = newId(route),
    preparationId = newId(route);
  expect(await readPreparationNativeHeader(db.admin, { route, accountId, preparationId })).toBeNull();
  await expect(
    readPreparationNativeHeader(db.admin, { route, accountId: newId(0x7b20), preparationId }),
  ).rejects.toThrow();
});
