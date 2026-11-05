import { expect, test } from 'bun:test';
import { DEVELOPMENT_SHOWCASE_SCOPES } from '../../../scripts/datasets/showcase-community.ts';
import { importerScopes, localClientIds, localShowcaseClientRegistration } from '../scripts/dev-stack.ts';

test('local showcase uses a separate first-party client while the importer stays import-only', () => {
  const registration = localShowcaseClientRegistration();
  expect(registration).toEqual({
    clientId: localClientIds.showcase,
    firstParty: true,
    scopes: [...DEVELOPMENT_SHOWCASE_SCOPES],
  });
  expect(localClientIds.showcase).not.toBe(localClientIds.importer);
  expect(importerScopes).not.toContain('board:create');
  expect(importerScopes).not.toContain('thread:create');
  expect(importerScopes).not.toContain('edition:sell');
  expect(importerScopes).not.toContain('offer:create');
  expect(DEVELOPMENT_SHOWCASE_SCOPES).toContain('board:create');
  expect(DEVELOPMENT_SHOWCASE_SCOPES).toContain('edition:sell');
  expect(DEVELOPMENT_SHOWCASE_SCOPES).toContain('offer:create');
  expect(DEVELOPMENT_SHOWCASE_SCOPES).toContain('offer:list');
});
