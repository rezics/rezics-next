import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COLLECTION_SELECTED_PUBLICATION_LIMIT } from '../../src/library/collection-selected-publication-bounds.ts';
import { COLLECTION_SOURCE_WORK_COST } from '../../src/library/collection-source-work-cost.ts';
import { MEMBERS_PREPARATION_SOURCE_COST } from '../../src/search/scope-members-source-declaration.ts';
import { SEARCH_SCOPE_ORDINAL_OPERATION } from '../../src/search/service-scope-order.ts';

const library = resolve(import.meta.dir, '../../src/library');
const search = resolve(import.meta.dir, '../../src/search');

test('Collection Source work cost initializes without native IO', () => {
  expect(COLLECTION_SOURCE_WORK_COST().state.statements).toBeGreaterThan(0);
  expect(MEMBERS_PREPARATION_SOURCE_COST().nativeRows).toBeGreaterThan(0);
  expect(COLLECTION_SELECTED_PUBLICATION_LIMIT).toBe(100);
  expect(SEARCH_SCOPE_ORDINAL_OPERATION().rawLimit).toBe(1);
  expect(readFileSync(resolve(search, 'scope-members-source-declaration.ts'), 'utf8')).toContain(
    "from '../library/collection-source-work-cost.ts'",
  );
  expect(readFileSync(resolve(search, 'scope-members-source-declaration.ts'), 'utf8')).not.toContain(
    'collection-source-work-native',
  );
  expect(readFileSync(resolve(library, 'collection-selected-publication-bounds.ts'), 'utf8')).not.toContain(
    'collection-source-work-native',
  );
  expect(readFileSync(resolve(search, 'service-scope-order.ts'), 'utf8')).toContain(
    "from '../library/collection-source-work-cost.ts'",
  );
});
