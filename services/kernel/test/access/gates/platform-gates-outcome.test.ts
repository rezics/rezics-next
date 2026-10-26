import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.PLATFORM_GATES_DRIVER_MODULE = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), 'platform-gates-outcome-driver.ts'),
).href;

await import('../../../../../specs/platform-gates-outcomes.test.ts');
