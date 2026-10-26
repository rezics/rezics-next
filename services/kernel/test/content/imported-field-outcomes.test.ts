import { fileURLToPath } from 'node:url';

process.env.IMPORTED_FIELD_DRIVER = fileURLToPath(new URL('./imported-field-driver.ts', import.meta.url));
await import('../../../../specs/imported-field-outcomes.test.ts');
