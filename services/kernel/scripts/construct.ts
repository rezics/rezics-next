import { withThrowawayDatabase } from './derived.ts';

async function construct(): Promise<void> {
  // Reylo reads DATABASE_URL while loading .sql modules, so import the kernel only after migration.
  const { kernelContract } = await import('./openapi.ts');
  await kernelContract();
}

if (import.meta.main) {
  try {
    // A parent typecheck already migrated the database named by DATABASE_URL. Share that container.
    if (process.env.DATABASE_URL) await construct();
    else await withThrowawayDatabase(() => construct());
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
