import { describe, expect, test } from 'bun:test';
import { accountErrorCodes } from '../../../services/account/src/http.ts';
import { classifyFailure } from '../features/api/errors.ts';
import { failureKeys, failureText } from '../features/account/failure-text.ts';
import { refusalMessages } from '../features/api/refusal-messages.ts';
import { acceptanceAfterSignIn, acceptanceSignInPath } from '../features/auth/policies.ts';

describe('G-942 Account refusals', () => {
  test('Account admission refusals are recognized in code, reason and error envelopes', () => {
    for (const field of ['code', 'reason', 'error']) {
      expect(classifyFailure(403, { [field]: 'policy_acceptance_required' })).toBe('policy-acceptance-required');
      expect(classifyFailure(403, { [field]: 'age_ineligible' })).toBe('age-ineligible');
    }
    expect(classifyFailure(403, { code: 'ACCOUNT_UNAVAILABLE' })).toBe('account-unavailable');
    expect(classifyFailure(400, { error: 'invalid_signature' })).toBe('expired-request');
  });
  test('every owner refusal is classified; only service failures use outage text in every locale', () => {
    for (const error of accountErrorCodes) {
      const kind = classifyFailure(error === 'temporarily_unavailable' ? 503 : 403, { error });
      expect(kind).not.toBe('failed');
    }
    for (const messages of Object.values(refusalMessages)) {
      const common = { ...messages, unavailableBody: 'OUTAGE' };
      for (const kind of Object.keys(failureKeys) as (keyof typeof failureKeys)[]) {
        expect(failureText(kind, common)).toBeTruthy();
        expect(failureText(kind, common) === 'OUTAGE').toBe(kind === 'unavailable');
      }
    }
    expect(classifyFailure(429, { code: 'policy_acceptance_required' })).toBe('rate-limited');
    expect(classifyFailure(503, { code: 'policy_acceptance_required' })).toBe('unavailable');
  });
});

describe('G-942 acceptance continuation', () => {
  test('keeps PKCE, state, all resources and app prompts without repeating completed authentication', () => {
    const oauth = new URLSearchParams('client_id=reader&state=opaque&code_challenge=challenge&code_challenge_method=S256&resource=one&resource=two&prompt=login+consent&max_age=0&sig=old&ba_param=client_id&ba_iat=old&exp=old');
    const destination = new URL(acceptanceAfterSignIn(oauth.toString(), '/', oauth.toString()), 'https://account.test');
    const resume = new URL(destination.searchParams.get('continue')!, destination.origin);
    expect(resume.pathname).toBe('/api/auth/oauth2/authorize');
    expect(resume.searchParams.getAll('resource')).toEqual(['one', 'two']);
    expect(resume.searchParams.get('state')).toBe('opaque');
    expect(resume.searchParams.get('code_challenge')).toBe('challenge');
    expect(resume.searchParams.get('prompt')).toBe('consent');
    for (const field of ['sig', 'ba_param', 'ba_iat', 'exp', 'max_age']) expect(resume.searchParams.has(field)).toBe(false);
    const back = new URL(destination.searchParams.get('return')!, destination.origin);
    expect(back.searchParams.get('sig')).toBe('old');
    expect(back.searchParams.get('policy_declined')).toBe('1');
  });
  test('plain sign-in keeps a safe destination and decline cannot leave the sign-in page', () => {
    const url = new URL(acceptanceAfterSignIn(undefined, '/security', 'next=%2Fsecurity'), 'https://account.test');
    expect(url.searchParams.get('next')).toBe('/security');
    expect(acceptanceSignInPath(url.searchParams.get('return'))).toContain('/sign-in?');
    for (const unsafe of ['//evil.test/sign-in?', '/security', '/sign-in/other?x=1', '/\\evil.test', null])
      expect(acceptanceSignInPath(unsafe)).toBe('/sign-in?policy_declined=1');
  });
});
