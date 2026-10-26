import { expect, setDefaultTimeout, test } from 'bun:test';
import { createLibraryDriver } from './support/outcome-driver.ts';

setDefaultTimeout(120_000);

const relations = [
  'collections',
  'members',
  'entries',
  'sessions',
  'completedUnits',
  'copies',
  'follows',
  'publishedLogs',
] as const;

test('seed grows every library relation with bulk rows and commits no command events', async () => {
  const driver = await createLibraryDriver();
  try {
    await driver.setTime('2030-01-02T00:00:00.000Z');
    const before = await driver.inspect();
    await driver.seed(1000);
    await driver.settle();
    const after = await driver.inspect();
    for (const relation of relations) {
      expect(after[relation].length - before[relation].length, relation).toBeGreaterThanOrEqual(1000);
    }
    expect(after.events.length - before.events.length).toBeLessThan(50);
    const known = new Set(before.collections.map((collection) => collection.id));
    const added = after.collections.filter((collection) => !known.has(collection.id));
    const owner = driver.accounts.owner.partition;
    expect(added.some((collection) => collection.partition === owner)).toBe(true);
    expect(added.some((collection) => collection.partition !== owner)).toBe(true);
  } finally {
    await driver.close();
  }
});
