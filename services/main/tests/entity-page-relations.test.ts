import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { includeDraftRelationPresentations } from '../src/modules/entity-page/relations.ts';

const sister = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const other = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';

test('a public relation uses its reviewed label for a signed-in reader', () => {
  // The definition is public vocabulary. A signed-in grant does not move it into `granted`,
  // so the page does not take the draft in place of the reviewed label.
  expect(includeDraftRelationPresentations({ public: new Set([sister]), granted: new Set() }, sister)).toBe(false);
});

test('draft wording is included only for a privately granted definition', () => {
  expect(includeDraftRelationPresentations(new Set([sister]), sister)).toBe(false);
  expect(includeDraftRelationPresentations({ public: new Set(), granted: new Set([other]) }, sister)).toBe(false);
  expect(includeDraftRelationPresentations({ public: new Set(), granted: new Set([sister]) }, sister)).toBe(true);
});

test('the wiki fixture reviews each relation label through the lexicon API', () => {
  const source = readFileSync(new URL('../../../apps/web/tests/g-849-records.ts', import.meta.url), 'utf8');
  const presentations = source.split("'/v1/lexicon/presentations'")[1] ?? '';
  expect(presentations).toContain("reviewStatus: 'reviewed'");
  expect(presentations).not.toContain("reviewStatus: 'draft'");
  expect(source).toContain("'lexicon.presentation.review'");
});
