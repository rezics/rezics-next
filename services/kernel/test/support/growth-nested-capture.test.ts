import { expect, test } from 'bun:test';
import { capture, openGrowthDatabase } from './growth-capture.ts';

test('nested database captures retain each operation scope and its executed plans', async () => {
  const application = await openGrowthDatabase();
  try {
    const auth = await openGrowthDatabase();
    try {
      const library = application.openPool({ max: 1 });
      const result = await capture(application, async () => {
        await application.pool.query('SELECT 1 AS before');
        const inner = await capture(auth, async () => {
          await application.pool.query('SELECT 2 AS application');
          await auth.pool.query('SELECT 3 AS auth');
          await library.query('SELECT 4 AS library');
        });
        await application.pool.query('SELECT 5 AS after');
        return inner.capture;
      });
      expect(result.capture.statements).toEqual([
        'SELECT 1 AS before',
        'SELECT 2 AS application',
        'SELECT 4 AS library',
        'SELECT 5 AS after',
      ]);
      expect(result.capture.plans).toHaveLength(4);
      expect(result.capture.backgroundStatements).toEqual([]);
      expect(result.value.statements).toEqual(['SELECT 3 AS auth']);
      expect(result.value.plans).toHaveLength(1);
      expect(result.value.backgroundStatements).toEqual([]);
    } finally {
      await auth.close();
    }
  } finally {
    await application.close();
  }
});
