import { fileURLToPath } from 'node:url';

process.env.ERASURE_OPERATION_DRIVER = fileURLToPath(new URL('./erasure-operation-driver.ts', import.meta.url));
await import('../../../../specs/erasure-operation-outcomes.test.ts');
