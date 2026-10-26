import { afterEach, beforeEach } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.PLATFORM_GATES_DRIVER_MODULE = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), 'platform-gates-outcome-driver.ts'),
).href;

// Link native SQL/Auth modules before the shared suite's per-case hook, as the
// other native gate adapters do. Database setup has four external commands,
// each bounded at 120 s; account registration and all proof work stay shared.
const { preparePlatformGatesAuthDatabase, closePreparedPlatformGatesAuthDatabase } =
  await import('./platform-gates-outcome-driver.ts');
beforeEach(preparePlatformGatesAuthDatabase, 4 * 120_000);
afterEach(closePreparedPlatformGatesAuthDatabase);

await import('../../../../../specs/platform-gates-outcomes.test.ts');
