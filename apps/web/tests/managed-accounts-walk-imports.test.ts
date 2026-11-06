import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('the seeded organization walk does not import packages Web does not depend on', () => {
  const source = readFileSync(resolve(import.meta.dir, '../scripts/managed-accounts-seeded-walk.ts'), 'utf8');
  expect(source).not.toMatch(/from ['"]@rezics\/auth-contract['"]/);
  expect(source).toContain("const AUTH_PAGE_OPERATION_CLIENT_ID = 'rezics-auth-account-operations'");
  expect(source).toContain("const AUTH_MANAGEMENT_CLIENT_ID = 'rezics-auth-account-management'");
  expect(source).toMatch(/operation\.kind === 'organization' \? \{\} : \{ accountId: session\.accountId \}/);
});
