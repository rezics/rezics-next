import { withThrowawayDatabase } from './derived.ts';

async function construct(): Promise<void> {
  // Reylo reads DATABASE_URL while loading .sql modules, so import the kernel only after migration.
  const { kernelContract, CONTRACT } = await import('./openapi.ts');
  const contract = await kernelContract();
  if (process.env.KERNEL_EMIT_OPENAPI === '1') await Bun.write(CONTRACT, contract);
}

if (import.meta.main) {
  try {
    // A parent typecheck already migrated the database named by DATABASE_URL. Share that container.
    if (process.env.DATABASE_URL) await construct();
    else await withThrowawayDatabase(() => construct());
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
