import { afterAll, beforeAll } from 'bun:test';
import { createRequire } from 'node:module';
import { kernelTestDatabase } from '../../scripts/database.ts';

export const nativeKernelSetupTimeout = 600_000;

/** Call after selecting the migrated Kernel database and before importing native consumers. */
export async function preloadNativeKernel(): Promise<void> {
  await import(createRequire(new URL('../../../kernel/package.json', import.meta.url)).resolve('reylo/register'));
  const { installNativeTestComposition } = await import('../../../kernel/test/support/native-history-composition.ts');
  await installNativeTestComposition();
}

/** Cold native SQL analysis is file setup. Keep its database live for lazy imports,
 * separately from the connections, deadlines and measured work of each scenario. */
export function beforeNativeKernelTests(load = preloadNativeKernel) {
  let analysis: ReturnType<typeof kernelTestDatabase> | undefined;
  beforeAll(async () => {
    analysis = kernelTestDatabase();
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = analysis.url;
    try {
      await load();
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  }, nativeKernelSetupTimeout);
  afterAll(() => analysis?.close());
}
