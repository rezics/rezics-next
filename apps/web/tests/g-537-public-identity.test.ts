import { expect, test } from 'bun:test';
import { agentName, identityOptions, type AgentDiscovery } from '../features/auth/acting-identity.ts';
import { checkCallback } from '../features/auth/callback-check.ts';
import { choiceKey } from '../app/identity/select/choice-key.ts';
import { messages as authMessages } from '../features/auth/messages.ts';
import { isSignInFailure, plainProviderCode, signInFailures } from '../features/auth/paths.ts';
import { messages as onboardingMessages } from '../features/onboarding/messages.ts';
import { uiLocales } from '../i18n/define.ts';

const issuer = 'https://account.test/api/auth';
const callback = (query: string) => new URL(`https://web.test/auth/callback?${query}`);

test('G-537: a callback is checked for issuer and state before the provider error is believed', () => {
  expect(checkCallback(callback(`iss=${encodeURIComponent(issuer)}&state=s&code=c`), issuer, 's', 'v'))
    .toEqual({ kind: 'proceed', code: 'c', verifier: 'v' });
  expect(checkCallback(callback('iss=https%3A%2F%2Fevil.test&state=s&code=c'), issuer, 's', 'v'))
    .toEqual({ kind: 'failed', reason: 'issuer' });
  for (const [state, expected, verifier] of [['x', 's', 'v'], ['s', undefined, 'v'], ['s', 's', undefined]] as const) {
    expect(checkCallback(callback(`iss=${encodeURIComponent(issuer)}&state=${state}&error=access_denied`),
      issuer, expected, verifier)).toEqual({ kind: 'failed', reason: 'state' });
  }
});

test('G-537: only access_denied is consent recovery; every other callback error says what failed', () => {
  const at = (query: string) => checkCallback(callback(`iss=${encodeURIComponent(issuer)}&state=s&${query}`),
    issuer, 's', 'v');
  expect(at('error=access_denied')).toEqual({ kind: 'denied' });
  expect(at('error=server_error')).toEqual({ kind: 'failed', reason: 'provider', providerCode: 'server_error' });
  expect(at('error=invalid_scope')).toEqual({ kind: 'failed', reason: 'provider', providerCode: 'invalid_scope' });
  // An error code that is not plain is not echoed back.
  expect(at('error=%3Cscript%3E')).toEqual({ kind: 'failed', reason: 'provider' });
  expect(at('')).toEqual({ kind: 'failed', reason: 'code' });
  expect(plainProviderCode('temporarily_unavailable')).toBe('temporarily_unavailable');
  expect(plainProviderCode('Not Plain')).toBeNull();
  expect(isSignInFailure('state')).toBe(true);
  expect(isSignInFailure('<b>')).toBe(false);
});

test('G-537: the sign-in failure page and identity choice speak all eight locales', () => {
  for (const locale of uiLocales) {
    const t = authMessages[locale];
    const reasons = [t.failedState, t.failedIssuer, t.failedCode, t.failedExchange, t.failedConfig,
      t.failedSession, t.failedProvider, t.failedUnknown];
    expect(new Set(reasons).size, locale).toBe(signInFailures.length);
    if (locale === 'en') continue;
    expect(t.signInFailedHeading, locale).not.toBe(authMessages.en.signInFailedHeading);
    expect(t.consentDeclined, locale).not.toBe(authMessages.en.consentDeclined);
    expect(t.organizationAgent, locale).not.toBe(authMessages.en.organizationAgent);
    expect(onboardingMessages[locale].displayName, locale).not.toBe(onboardingMessages.en.displayName);
  }
  expect(authMessages.ja.organizationAgent).toBe('組織');
  expect(authMessages.de.organizationAgent).toBe('Organisation');
});

test('G-537: every Agent Main lists is a choice, with its kind and its own label language and direction', () => {
  const org = 'https://rezics.com/id/b8df6385-cec9-4fa0-8b89-71def5fa82b5';
  const person = 'https://rezics.com/id/1e1489d5-6994-402c-99f2-50547eeaef4d';
  const pen = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const discovery: AgentDiscovery = { items: [
    { actingSubject: org, kind: 'organization', handle: null,
      displayName: { value: 'مؤسسة النور', language: 'ar', direction: 'rtl' } },
    { actingSubject: person, kind: 'person', handle: 'meilin',
      displayName: { value: '林梅', language: 'zh-Hant', direction: 'ltr' } },
    { actingSubject: pen, kind: null, handle: null, displayName: null }] };
  // Only the publishing list knows an authority path; an Agent outside it has none.
  const options = identityOptions(discovery, [
    { iri: person, label: null, handle: null, kind: null, path: 'direct-principal' }]);
  expect(options.map(option => [option.iri, option.kind, option.label, option.path])).toEqual([
    [org, 'organization', 'مؤسسة النور', null], [person, 'person', '林梅', 'direct-principal'],
    [pen, null, null, null]]);
  expect(options[0]!.labelText).toEqual({ language: 'ar', direction: 'rtl' });
  expect(options[2]!.labelText).toBeUndefined();
  expect(agentName(options[1]!, authMessages.ja)).toBe('林梅');
  expect(agentName(options[2]!, authMessages.de)).toBe('Identität 00000000');
});

test('G-537: the idempotency key follows what the form showed, so a browser retry replays', () => {
  const agent = 'https://rezics.com/id/b8df6385-cec9-4fa0-8b89-71def5fa82b5';
  const other = 'https://rezics.com/id/1e1489d5-6994-402c-99f2-50547eeaef4d';
  const key = choiceKey('session', 'session-1', null, agent);
  expect(choiceKey('session', 'session-1', null, agent)).toBe(key);
  expect(choiceKey('session', 'session-1', 'revision-2', agent)).not.toBe(key);
  expect(choiceKey('session', 'session-1', null, other)).not.toBe(key);
  expect(choiceKey('session', 'session-2', null, agent)).not.toBe(key);
  expect(choiceKey('main', 'session-1', null, agent)).not.toBe(key);
  expect(key).toMatch(/^[A-Za-z0-9:_./-]{1,128}$/);
});
