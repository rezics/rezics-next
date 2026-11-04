import { expect, test } from 'bun:test';
import { parseConsentRequestedScopes, projectConsentPage } from '../src/consent-page.ts';

const client = { client_id: 'reader', display_name: 'Reader', first_party: false, scopes: ['openid', 'read'] };
const identity = { account_id: 'person-1', email: 'person@example.test' };

test('consent projection preserves unknown request names and shows the admitted account and existing grant', () => {
  const requested = parseConsentRequestedScopes('read account:manage');
  expect(requested).toEqual(['read', 'account:manage']);
  expect(
    projectConsentPage({
      client,
      identity,
      requested: requested!,
      consent: { scopes: ['openid'], pending_scopes: null },
    }),
  ).toEqual({
    client_id: 'reader',
    display_name: 'Reader',
    scopes: ['openid', 'read'],
    requested: ['read', 'account:manage'],
    granted: ['openid'],
    pending_reduction: false,
    acting_account: identity,
    decisions: { allow: true, decline: true, switch_account: true },
  });
});

test('bounded malformed or unavailable consent projections cannot look like empty review', () => {
  expect(parseConsentRequestedScopes('read\nwrite')).toBeNull();
  expect(parseConsentRequestedScopes('x'.repeat(8193))).toBeNull();
  expect(
    projectConsentPage({
      client,
      identity,
      requested: ['read'],
      consent: { scopes: ['openid', 'read'], pending_scopes: ['openid'] },
    })?.decisions,
  ).toEqual({ allow: false, decline: true, switch_account: true });
  expect(
    projectConsentPage({
      client,
      identity,
      requested: ['read'],
      consent: { scopes: ['retired:permission'], pending_scopes: null },
    }),
  ).toBeNull();
});
