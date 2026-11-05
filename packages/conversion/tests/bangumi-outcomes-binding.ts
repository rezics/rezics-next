import { resolve } from 'node:path';

process.env.IMPORT_BANGUMI_DRIVER = resolve(import.meta.dir, 'bangumi-driver.ts');
