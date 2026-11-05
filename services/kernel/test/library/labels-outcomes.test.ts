import { resolve } from 'node:path';

process.env.LIBRARY_LABELS_DRIVER = resolve(import.meta.dir, 'support/native-labels-driver.ts');
await import('../../../../specs/library-labels-outcomes.test.ts');
