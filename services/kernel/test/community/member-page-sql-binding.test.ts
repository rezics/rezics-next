import { expect, test } from 'bun:test';
import page from '../../src/community/member-page-select.sql';

test('member page binds each input once and keeps raw page and lookahead limits', () => {
  expect(page.sql.match(/:[a-z_]+/g)).toEqual([':route', ':realm_id', ':at', ':after']);
  expect(page.sql).toContain('LIMIT 20');
  expect(page.sql).toContain('AS "hasMore"');
});
