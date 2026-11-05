import {
  CONSENT_PAGE_MAX_RESPONSE_BYTES,
  CONSENT_PAGE_MAX_ERROR_BYTES,
  CONSENT_DECISION_MAX_RESPONSE_BYTES,
  CONSENT_DECISION_MAX_ERROR_BYTES,
} from '@rezics/auth-contract';
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

test('the closed projection fits the shared finite allowance with every compatible maximal field', () => {
  const scopes = Array.from({ length: 1000 }, (_, i) => String(i).padStart(128, 'x'));
  const requested = Array.from({ length: 1000 }, (_, i) => i.toString(36).padStart(3, '0'));
  const page = projectConsentPage({
    client: { client_id: '\u0001'.repeat(1024), display_name: '\u0001'.repeat(100), first_party: false, scopes },
    identity: { account_id: '\u0001'.repeat(1024), email: '\u0001'.repeat(250) + '@x.y' },
    requested,
    consent: { scopes, pending_scopes: null },
  });
  expect(page).not.toBeNull();
  expect(page?.scopes.length).toBe(1000);
  expect(page?.requested.length).toBe(1000);
  expect(page?.granted.length).toBe(1000);
  expect(page?.decisions.allow).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(CONSENT_PAGE_MAX_RESPONSE_BYTES);
  const acknowledgement = {
    account_id: page!.acting_account.account_id,
    client_id: page!.client_id,
    requested: page!.requested,
    scope: [...new Set([...page!.granted, ...page!.requested.filter((scope) => page!.scopes.includes(scope))])],
  };
  expect(acknowledgement.scope.length).toBe(1000);
  expect(new TextEncoder().encode(JSON.stringify(acknowledgement)).length).toBeLessThanOrEqual(
    CONSENT_DECISION_MAX_RESPONSE_BYTES,
  );
  expect(CONSENT_PAGE_MAX_ERROR_BYTES).toBe(
    JSON.stringify({ error: 'authentication_denied', code: 'stale_review' }).length,
  );
  expect(CONSENT_DECISION_MAX_ERROR_BYTES).toBe(
    Math.max(
      JSON.stringify({ error: 'authentication_denied', code: 'stale_review' }).length,
      JSON.stringify({ error: 'step_up_required', effect_status: 'not_applied' }).length,
      JSON.stringify({ error: 'account_suspended', code: 'ACCOUNT_SUSPENDED' }).length,
    ),
  );
});
