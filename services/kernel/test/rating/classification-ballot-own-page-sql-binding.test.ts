import { expect, test } from 'bun:test';
import page from '../../src/rating/classification-ballot-own-page-raw.sql';

test('own ballot page binds each input once and preserves nullable exact-slot exclusion', () => {
  expect(page.params).toEqual([
    'route',
    'actor_id',
    'generation',
    'after_subject',
    'after_association',
    'selected_subject',
    'selected_association',
  ]);
  expect(page.sql).toContain('args.arg_selected_subject IS NULL');
  expect(page.sql).toContain('ballot.subject_id, ballot.association_id) <>');
  expect(page.sql).toContain('LIMIT 21');
});
