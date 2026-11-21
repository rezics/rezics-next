import { openGrowthDatabase } from './growth.ts';
import { openIsolatedDatabase } from './isolated-database.ts';

/** Discard the complete fixture when a test seeds immutable log history. */
export async function openIsolatedGrowthDatabase() {
  const fixture = await openIsolatedDatabase();
  try {
    const db = await openGrowthDatabase(fixture.url);
    return {
      database: db,
      async close() {
        try {
          await db.close();
        } finally {
          await fixture.close();
        }
      },
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
