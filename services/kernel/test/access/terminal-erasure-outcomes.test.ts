import { setDefaultTimeout } from 'bun:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const driver = pathToFileURL(resolve(import.meta.dir, './terminal-erasure-outcomes-driver.ts')).href;
process.env.TERMINAL_ERASURE_DRIVER = driver;

await import(driver);
await import('../../../../specs/terminal-erasure-outcomes.test.ts');
setDefaultTimeout(180_000);
