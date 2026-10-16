import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');

test('container and native fixture producers select the same PostgreSQL UTF-8 collation provider', () => {
  expect(readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8'))
    .toContain('POSTGRES_INITDB_ARGS: --locale-provider=builtin --locale=C.UTF-8 --encoding=UTF8');
});
