import { expect, test } from 'bun:test';
import { validateMigrationVersions } from '../scripts/database.ts';

test('a migration more than five minutes in the future is refused with its file name', () => {
  const file = 'db/content/migrations/20261025120600_content_future.sql';

  expect(() => validateMigrationVersions([file], new Date('2026-10-25T12:00:00Z'))).toThrow(
    new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*date -u \\+%Y%m%d%H%M%S`, 's'),
  );
});

test('migration versions are unique across modules', () => {
  const first = 'db/access/migrations/20261025110000_access.sql';
  const second = 'db/content/migrations/20261025110000_content.sql';

  expect(() => validateMigrationVersions([first, second], new Date('2026-10-25T12:00:00Z'))).toThrow(
    new RegExp(
      `${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*${second.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*date -u \\+%Y%m%d%H%M%S`,
      's',
    ),
  );
});
