import { resolve } from 'node:path';

process.env.DYNAMIC_COLLECTIONS_DRIVER = resolve(import.meta.dir, 'support/native-dynamic-driver.ts');
await import('../../../../specs/dynamic-collections-outcomes.test.ts');
