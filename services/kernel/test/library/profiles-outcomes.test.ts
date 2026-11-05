import { resolve } from 'node:path';

process.env.LIBRARY_PROFILES_DRIVER = resolve(import.meta.dir, 'support/native-profiles-driver.ts');
await import('../../../../specs/library-profiles-outcomes.test.ts');
