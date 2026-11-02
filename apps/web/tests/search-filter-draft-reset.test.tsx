import { expect, test } from 'bun:test';
import type { FilterDocument } from '@rezics/filter';
import { createFilterDraft, resetFilterDraft } from '../src/search/filter-draft-reset';

test('revert restores the committed condition and language order and clears attempted validation', () => {
  const baseline = { condition: { type: { in: ['schema:Book'] } } as FilterDocument, languages: ['ja', 'en'] };
  const key = 'current-search';
  const draft = {
    ...createFilterDraft(key, baseline),
    condition: { statement: { property: 'schema:inLanguage', in: [''] } } as FilterDocument,
    languages: ['fr'],
    attempted: true,
  };

  expect(resetFilterDraft(draft, key, key, baseline)).toEqual(createFilterDraft(key, baseline));
});

test('a late revert callback cannot restore a preceding search', () => {
  const draft = createFilterDraft('new-search', { languages: ['de'] });

  expect(resetFilterDraft(draft, 'old-search', 'new-search', { languages: ['en'] })).toBe(draft);
});
