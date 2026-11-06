import { expect, setDefaultTimeout } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const suite = resolve(import.meta.dir, '../../../../specs/imports-vndb-statistics.test.ts');
expect(readFileSync(suite, 'utf8').match(/^test\(/gm)?.length).toBe(6);
// Register the unchanged portable cases in the admitted native test process.
// A nested test runner owns another startup/lease lifetime and hides each
// reached stage until its entire six-case process exits.
process.env.IMPORT_VNDB_STATISTICS_DRIVER = resolve(import.meta.dir, 'vndb-statistics-driver.ts');
setDefaultTimeout(120_000);
await import(suite);
