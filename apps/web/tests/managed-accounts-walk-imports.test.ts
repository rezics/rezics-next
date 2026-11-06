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

test('the seeded walk mints website Kernel bearers through login then OAuth, never native website sign-in', () => {
  const source = readFileSync(resolve(import.meta.dir, '../scripts/managed-accounts-seeded-walk.ts'), 'utf8');
  expect(source).not.toMatch(/developerSignIn\([^)]*WEBSITE_CLIENT_ID/);
  expect(source).not.toMatch(/signIn\([^;]*WEBSITE_CLIENT_ID/);
  expect(source).toContain('client_id: WEBSITE_CLIENT_ID');
  expect(source).toContain("grant_type: 'authorization_code'");
  expect(source).toContain("signIn(stack, person, 'login', [], secret)");
});

test('Accounts management does not import Settings private managed-account reads', () => {
  for (const file of ['actions.ts', 'data.ts', 'pages.tsx', 'auth-navigation.ts']) {
    const source = readFileSync(resolve(import.meta.dir, `../src/accounts/management/${file}`), 'utf8');
    expect(source).not.toMatch(/settings\/managed-account/);
  }
});

test('native web stack loads Commerce and Work only after DATABASE_URL setup', () => {
  const source = readFileSync(resolve(import.meta.dir, './native/stack.ts'), 'utf8');
  expect(source).not.toMatch(/^import \{ createCommerceWork/m);
  expect(source).not.toMatch(/^import \{ readCommerceConfig/m);
  expect(source).not.toMatch(/^import \{ createStripePort/m);
  expect(source).not.toMatch(/^import \{ createWorkClient/m);
  expect(source).toContain("import('../../../../services/kernel/src/commerce/enqueue.ts')");
  expect(source).toContain("import('../../../../services/kernel/src/work/client.ts')");
  const databaseUrlIndex = source.indexOf('process.env.DATABASE_URL = databaseUrl');
  const commerceImportIndex = source.indexOf("import('../../../../services/kernel/src/commerce/enqueue.ts')");
  expect(databaseUrlIndex).toBeGreaterThan(-1);
  expect(commerceImportIndex).toBeGreaterThan(databaseUrlIndex);
});
