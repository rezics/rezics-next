import { describe, expect, test } from 'bun:test';
import { classifyFailure, refusedMinimumAge } from '../features/api/errors.ts';
import { acceptanceContinuation, acceptances, parsePolicyStatus, policyHref,
  regionName } from '../features/auth/policies.ts';
import { policyFixture } from '../features/auth/policies.fixture.ts';
import { accountsConfig } from '../features/config/env.ts';
import { POLICY_VERSIONS } from '../../../services/account/src/policy-versions.ts';

describe('G-736 sign-up refusals', () => {
  test('Account’s admission reasons become typed outcomes with the minimum age', () => {
    const body = { reason: 'minimum_age_confirmation_required', minimumAge: 14 };
    expect(classifyFailure(400, body)).toBe('minimum-age-confirmation-required');
    expect(refusedMinimumAge(body)).toBe(14);
    expect(refusedMinimumAge({ minimumAge: '14' })).toBeUndefined();
    for (const [reason, kind] of [['minimum_age_confirmation_required', 'minimum-age-confirmation-required'], ['market_unavailable', 'market-unavailable'],
      ['policy_acceptance_required', 'policy-acceptance-required']] as const) {
      expect(classifyFailure(400, { reason })).toBe(kind);
    }
  });

  test('other failures keep their existing outcome', () => {
    expect(classifyFailure(429, { reason: 'market_unavailable' })).toBe('rate-limited');
    expect(classifyFailure(400, { code: 'PASSWORD_TOO_SHORT' })).toBe('password-too-short');
    expect(classifyFailure(422, { code: 'USER_ALREADY_EXISTS' })).toBe('failed');
  });
});

describe('G-736 policy status', () => {
  const wire = { acceptanceRequired: true, policies: POLICY_VERSIONS.map(version => ({ ...version })) };

  test('reads Account’s answer exactly and refuses any other shape', () => {
    expect(parsePolicyStatus(wire)?.policies.map(policy => policy.policyId)).toEqual(['terms', 'privacy']);
    expect(parsePolicyStatus({ ...wire, policies: [] })).toBeNull();
    expect(parsePolicyStatus({ ...wire, acceptanceRequired: 'yes' })).toBeNull();
    expect(parsePolicyStatus({ ...wire, policies: [{ ...wire.policies[0], versionDigest: 'short' }] })).toBeNull();
    expect(parsePolicyStatus({ ...wire, policies: [{ ...wire.policies[0], policyId: 'cookies' }] })).toBeNull();
  });

  test('an acceptance sends only the displayed policy and digest', () => {
    expect(acceptances(policyFixture)).toEqual([{ policyId: 'terms', versionDigest: 'a'.repeat(64) },
      { policyId: 'privacy', versionDigest: 'b'.repeat(64) }]);
  });

  test('links point at the about site page of the person’s locale', () => {
    expect(policyHref('https://rezics.com/', 'ja', 'privacy')).toBe('https://rezics.com/ja/legal/privacy/');
    expect(accountsConfig({}).ABOUT_SITE_URL).toBe('https://rezics.com');
  });

  test('acceptance resumes only a refused authorization request', () => {
    const authorize = '/api/auth/oauth2/authorize?client_id=reader&sig=abc';
    expect(acceptanceContinuation(authorize)).toBe(authorize);
    expect(acceptanceContinuation('/oauth2/authorize?client_id=x')).toBe('/oauth2/authorize?client_id=x');
    for (const unsafe of ['https://evil.example/', '//evil.example', '/security', '/api/auth/sign-out', null, '']) {
      expect(acceptanceContinuation(unsafe)).toBe('/');
    }
  });
});

describe('G-736 region', () => {
  test('the region is named in the person’s language, or not at all when unknown', () => {
    expect(regionName('KR', 'en')).toBe('South Korea');
    expect(regionName('DE', 'de')).toBe('Deutschland');
    for (const unknown of [null, undefined, '', 'XX', 'usa']) expect(regionName(unknown, 'en')).toBeNull();
  });
});
