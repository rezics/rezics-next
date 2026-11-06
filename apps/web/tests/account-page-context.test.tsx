import { expect, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import { accountPageContextFromReads, accountOperationAllowed } from '../src/features/pages/account-read';
import { loadPublicAccountJourney, pageProfile } from '../src/accounts/public-profile/page-read';
import { profilePage } from '../src/stories/pages/accounts-public-profile/fixtures';

const accountId = '0192f3a0-6c1e-7b2a-8000-000000000011';
const operatorId = '0192f3a0-6c1e-7b2a-8000-000000000012';
const subjectId = '0192f3a0-6c1e-7b2a-8000-000000000013';
const publicBody = {
  accounts: [
    {
      id: accountId,
      kind: 'actor',
      state: 'active',
      handle: 'reader',
      operatorId,
      verified: false,
      subject: { id: subjectId, label: 'Native graph link', type: 'schema:Person' },
      privateEmail: 'private@example.test',
    },
  ],
};

test('personal context contains the matching public allowlist and only source-supplied viewer actions', () => {
  const context = accountPageContextFromReads(accountId, publicBody, {
    state: 'ready',
    actions: [{ action: 'account:update', operations: ['account.update'] }],
    securityHref: 'https://auth.test/security',
  });
  expect(context).toMatchObject({
    state: 'ready',
    viewerState: 'signed-in',
    profile: { id: accountId, operated: true, operatorId: null, subject: { id: subjectId }, verified: false },
    actions: [{ action: 'account:update', operations: ['account.update'] }],
  });
  expect(JSON.stringify(context)).not.toContain(operatorId);
  expect(JSON.stringify(context)).not.toContain('private@example.test');
  expect(accountOperationAllowed(context, 'account:update', 'account.update')).toBe(true);
  expect(accountOperationAllowed(context, 'account:update', 'account.set_preferences')).toBe(false);
});

test('anonymous context uses only the public reader; failed or contradictory advice stays unavailable', () => {
  expect(accountPageContextFromReads(accountId, publicBody, undefined)).toMatchObject({
    state: 'ready',
    viewerState: 'signed-out',
    actions: [],
    securityHref: null,
  });
  expect(accountPageContextFromReads(accountId, publicBody, { state: 'unavailable' })).toEqual({
    state: 'unavailable',
  });
  expect(accountPageContextFromReads(operatorId, publicBody, undefined)).toEqual({ state: 'unavailable' });
});

test('an unreadable operator keeps the relationship label and omits its raw identifier from public page output', async () => {
  const page = profilePage({ profile: { automated: true, operatorId } });
  const client = {
    pages: { $read: { post: async () => ({ status: 200, data: { ...page, account: page.account!.id } }) } },
    accounts: { get: async () => ({ status: 404, error: { value: { code: 'not_found' } } }) },
  } as unknown as KernelClient;
  const result = await loadPublicAccountJourney(client, { handle: 'reader', locale: 'en' });
  if (result.kind !== 'page') throw new Error(`Expected page, received ${result.kind}`);
  expect(pageProfile(result.page)?.operated).toBe(true);
  expect(pageProfile(result.page)?.operatorId).toBeNull();
  expect(pageProfile(result.overview)?.operatorId).toBeNull();
  expect(JSON.stringify(result.page.reads)).not.toContain(operatorId);
  expect(JSON.stringify(result)).not.toContain(operatorId);
});
