import { withThrowawayDatabase } from './derived.ts';

if (import.meta.main) {
  try {
    await withThrowawayDatabase(async () => {
      // Reylo reads DATABASE_URL while loading .sql modules, so import the kernel only after migration.
      const { kernelContract } = await import('./openapi.ts');
      await kernelContract();
    });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
