import { resolve } from 'node:path';

process.env.LIBRARY_SHELVES_DRIVER = resolve(import.meta.dir, 'support/native-shelves-driver.ts');
await import('../../../../specs/library-shelves-outcomes.test.ts');
