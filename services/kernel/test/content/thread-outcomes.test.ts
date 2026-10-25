import { test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { openMeasuredThreadCreate } from './thread-driver.ts';

process.env.CONTENT_THREAD_DRIVER = fileURLToPath(new URL('./thread-driver.ts', import.meta.url));

await import('../../../../specs/content-thread-outcomes.test.ts');

test('checkGrowth proves the declared three-scale machine-independent bound', async () => {
  const database = await openGrowthDatabase();
  try {
    const measured = await openMeasuredThreadCreate(database);
    try {
      const report = await checkGrowth(database, {
        name: 'content.thread.create',
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
