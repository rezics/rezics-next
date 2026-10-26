import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const driver = pathToFileURL(resolve(directory, 'command-admission-outcome-driver.ts')).href;
process.env.COMMAND_ADMISSION_DRIVER_MODULE = driver;

// Loading the kernel module graph is not part of the first case's budget: it takes seconds on a loaded host.
await import('./command-admission-outcome-driver.ts');
await import('../../../../specs/command-admission-outcomes.test.ts');
