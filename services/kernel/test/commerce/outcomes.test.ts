import { resolve } from 'node:path';

process.env.COMMERCE_DRIVER = resolve(import.meta.dir, 'support/outcome-driver.ts');
await import('../../../../specs/commerce-outcomes.test.ts');
