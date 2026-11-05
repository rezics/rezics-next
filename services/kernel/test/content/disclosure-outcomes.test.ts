import { afterAll, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { openMeasuredDisclosure, prepareDisclosureWorker } from './disclosure-driver.ts';

const worker = await prepareDisclosureWorker();
afterAll(() => worker.close());

process.env.CONTENT_DISCLOSURE_DRIVER = fileURLToPath(new URL('./disclosure-driver.ts', import.meta.url));

await import('../../../../specs/content-disclosure-outcomes.test.ts');

test('checkGrowth proves the declared three-scale machine-independent bound', async () => {
  const database = await openGrowthDatabase();
  try {
    const measured = await openMeasuredDisclosure(database);
    try {
      const report = await checkGrowth(database, {
        name: 'content.disclosure.list',
        scales: [32, 256, 2048],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        grow: (db, scale, previous) => measured.grow(db, scale, previous),
        operation: (db, scale, repetition) => measured.operation(db, scale, repetition),
      });
      console.log(JSON.stringify(report));
    } finally {
      await measured.close();
    }
  } finally {
    await database.close();
  }
}, 180_000);
