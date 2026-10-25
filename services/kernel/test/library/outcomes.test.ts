import { resolve } from 'node:path';

process.env.LIBRARY_DRIVER = resolve(import.meta.dir, 'support/outcome-driver.ts');
await import('../../../../specs/library-outcomes.test.ts');
