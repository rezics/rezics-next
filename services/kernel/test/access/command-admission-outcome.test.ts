import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
process.env.COMMAND_ADMISSION_DRIVER_MODULE = pathToFileURL(
  resolve(directory, 'command-admission-outcome-driver.ts'),
).href;

await import('./command-admission-outcome-driver.ts');
await import('../../../../specs/command-admission-outcomes.test.ts');
