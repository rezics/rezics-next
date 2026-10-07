import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAIN_SITE_SCOPE } from '../../apps/web/features/auth/scopes.ts';
import { parseWebAuthOptions, reconcileWebClient, retiredOperator, type WebClientAccount,
  type WebClientRegistrationState, WebClientNotUpdatable, webClientCurrent, webClientReconcileMessage,
  webClientRegistration } from './web-auth-bootstrap.ts';

test('IAM01: local web auth bootstrap accepts only a disposable run and exact loopback callback', () => {
  expect(parseWebAuthOptions(['--run-id', 'web-demo', '--redirect-uri',
    'http://localhost:3000/auth/callback', '--redirect-uri',
    'http://127.0.0.1:3003/auth/callback'])).toEqual({
    runId: 'web-demo', redirectUris: ['http://localhost:3000/auth/callback',
      'http://127.0.0.1:3003/auth/callback'],
  });
  for (const redirect of [
    'https://localhost:3000/auth/callback', 'http://example.test:3000/auth/callback',
    'http://localhost.evil.test:3000/auth/callback', 'http://localhost/auth/callback',
    'http://localhost:3000/auth/callback?next=evil',
    'http://localhost:3000/auth/callback#fragment',
  ]) {
    expect(() => parseWebAuthOptions(['--run-id', 'web-demo', '--redirect-uri', redirect]))
      .toThrow();
  }
  expect(() => parseWebAuthOptions(['--run-id', '../dev', '--redirect-uri',
    'http://localhost:3000/auth/callback'])).toThrow();
});

test('IAM01: re-registration reuses an authorized retired fixture operator', async () => {
  const stack = mkdtempSync('.temp/web-auth-retired-');
  try {
    for (const [time, id] of [['100', 'old'], ['200', 'new']]) {
      const directory = join(stack, `web-auth.retired-${time}`);
      mkdirSync(directory);
      writeFileSync(join(directory, 'private.json'), JSON.stringify({
        operator: { id, email: `${id}@example.test`, password: `password-${id}` },
      }));
    }
    const tried: string[] = [];
    const chosen = await retiredOperator(stack, async operator => {
      tried.push(operator.id);
      return operator.id === 'old' ? operator : undefined;
    });
    expect(tried).toEqual(['new', 'old']);
    expect(chosen?.email).toBe('old@example.test');
  } finally { rmSync(stack, { recursive: true, force: true }); }
});

test('IAM01: the local web client asks for the main site\'s scopes with PKCE and refresh, and older registrations are replaced', () => {
  const registration = webClientRegistration(['http://localhost:3000/auth/callback']);
  expect(registration).toMatchObject({ client_name: 'REZICS', application_type: 'native', token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], scope: MAIN_SITE_SCOPE,
    require_pkce: true, skip_consent: true, redirect_uris: ['http://localhost:3000/auth/callback'] });
  const current = { scope: MAIN_SITE_SCOPE, name: 'REZICS', firstParty: true, skipConsent: true, installationState: 'active',
    installationScopes: MAIN_SITE_SCOPE.split(' '), grantTypes: ['authorization_code', 'refresh_token'] };
  expect(webClientCurrent(current)).toBe(true);
  expect(webClientCurrent({ ...current, installationScopes: current.installationScopes.filter(scope => scope !== 'follow:read') })).toBe(false);
  expect(webClientCurrent({ ...current, installationState: 'revoked' })).toBe(false);
  expect(webClientCurrent({ ...current, name: 'QA-only loopback PKCE' })).toBe(false);
  expect(webClientCurrent({ ...current, firstParty: false })).toBe(false);
  expect(webClientCurrent({ ...current, skipConsent: false })).toBe(false);
  expect(webClientCurrent({ ...current, skipConsent: undefined })).toBe(false);
  expect(webClientCurrent({ ...current, grantTypes: ['authorization_code'] })).toBe(false);
});

const redirectUris = ['http://localhost:3000/auth/callback'];
const savedClient = { clientId: 'web-client', redirectUris };
const siteScopes = MAIN_SITE_SCOPE.split(' ');

function registeredClient(overrides: Partial<WebClientRegistrationState> = {}): WebClientRegistrationState {
  return { name: 'REZICS', scopes: [...siteScopes], grantTypes: ['authorization_code', 'refresh_token'],
    installationScopes: [...siteScopes], installationState: 'active', installationId: 'install-1',
    firstParty: true, skipConsent: true, ...overrides };
}

function fakeAccount(createdId = 'new-client') {
  const updates: { clientId: string; update: object }[] = [];
  const registrations: object[] = [];
  const firstParty: string[] = [];
  const replacements: { clientId: string; installationId: string | undefined; scopes: readonly string[] }[] = [];
  const account: WebClientAccount = {
    async updateClient(clientId, update) {
      updates.push({ clientId, update });
      expect(update).not.toHaveProperty('client_secret');
      expect(update).not.toHaveProperty('token_endpoint_auth_method');
      expect(Object.keys(update).sort()).toEqual(['client_name', 'grant_types', 'redirect_uris', 'scope', 'skip_consent']);
      return { client_id: clientId };
    },
    async registerClient(registration) {
      registrations.push(registration);
      return { client_id: createdId };
    },
    async markFirstParty(clientId) { firstParty.push(clientId); },
    async replaceInstallation(clientId, installationId, scopes) {
      replacements.push({ clientId, installationId, scopes });
    },
  };
  return { account, updates, registrations, firstParty, replacements };
}

test('IAM01: a stale web client is updated in place and keeps its client id', async () => {
  const fake = fakeAccount();
  const stale = registeredClient({ name: 'QA-only loopback PKCE', firstParty: false, skipConsent: false,
    grantTypes: ['authorization_code'],
    scopes: siteScopes.filter(scope => scope !== 'follow:read'),
    installationScopes: siteScopes.filter(scope => scope !== 'follow:read') });
  const outcome = await reconcileWebClient(fake.account, savedClient, stale);
  expect(outcome).toEqual({ case: 'updated', clientId: 'web-client' });
  expect(webClientReconcileMessage(outcome)).toBe('Web OAuth client updated in place: web-client');
  expect(fake.updates).toEqual([{ clientId: 'web-client', update: {
    client_name: 'REZICS', redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'], scope: MAIN_SITE_SCOPE, skip_consent: true } }]);
  expect(fake.registrations).toEqual([]);
  expect(fake.firstParty).toEqual(['web-client']);
  expect(fake.replacements).toEqual([{ clientId: 'web-client', installationId: 'install-1', scopes: [...siteScopes] }]);
  const refused = fakeAccount();
  refused.account.updateClient = async () => ({ client_id: 'other-client' });
  await expect(reconcileWebClient(refused.account, savedClient, stale)).rejects.toThrow('changed the web client id');
  expect(refused.registrations).toEqual([]);
  expect(refused.firstParty).toEqual([]);
});

test('IAM01: a missing web client is registered', async () => {
  const fake = fakeAccount();
  const outcome = await reconcileWebClient(fake.account, savedClient, undefined);
  expect(outcome).toEqual({ case: 'registered', clientId: 'new-client' });
  expect(webClientReconcileMessage(outcome)).toBe('Web OAuth client registered: new-client');
  expect(fake.registrations).toEqual([webClientRegistration(redirectUris)]);
  expect(fake.updates).toEqual([]);
  expect(fake.replacements).toEqual([]);
  expect(fake.firstParty).toEqual(['new-client']);
});

test('IAM01: a revoked web client installation is re-registered and reported', async () => {
  const fake = fakeAccount();
  const outcome = await reconcileWebClient(fake.account, savedClient, registeredClient({
    installationState: 'revoked', installationId: undefined, installationScopes: undefined }));
  expect(outcome).toEqual({ case: 'reregistered', clientId: 'new-client', previousClientId: 'web-client',
    reason: 'its installation was revoked' });
  expect(webClientReconcileMessage(outcome)).toBe(
    'Web OAuth client re-registered because its installation was revoked: new-client (was web-client)');
  expect(fake.updates).toEqual([]);
  expect(fake.replacements).toEqual([]);
  expect(fake.registrations).toHaveLength(1);
  expect(fake.firstParty).toEqual(['new-client']);
  const disabled = fakeAccount('disabled-client');
  const disabledOutcome = await reconcileWebClient(disabled.account, savedClient, registeredClient({ disabled: true }));
  expect(disabledOutcome).toEqual({ case: 'reregistered', clientId: 'disabled-client', previousClientId: 'web-client',
    reason: 'it is disabled' });
  expect(webClientReconcileMessage(disabledOutcome)).toContain('it is disabled');
  expect(disabled.updates).toEqual([]);
});

test('IAM01: an active installation that already admits the site scopes is kept', async () => {
  const grantsOnly = fakeAccount();
  const grants = await reconcileWebClient(grantsOnly.account, savedClient,
    registeredClient({ grantTypes: ['authorization_code'] }));
  expect(grants).toEqual({ case: 'updated', clientId: 'web-client' });
  expect(grantsOnly.replacements).toEqual([]);
  const uninstalled = fakeAccount();
  const installed = await reconcileWebClient(uninstalled.account, savedClient, registeredClient({
    installationState: undefined, installationId: undefined, installationScopes: undefined }));
  expect(installed).toEqual({ case: 'updated', clientId: 'web-client' });
  expect(uninstalled.replacements).toEqual([{ clientId: 'web-client', installationId: undefined, scopes: [...siteScopes] }]);
  const current = fakeAccount();
  expect(await reconcileWebClient(current.account, savedClient, registeredClient())).toEqual({
    case: 'current', clientId: 'web-client' });
  expect(current.updates).toEqual([]);
  expect(current.registrations).toEqual([]);
});

test('IAM01: a web client the operator cannot update is re-registered, and other failures are not', async () => {
  const refused = fakeAccount();
  refused.account.updateClient = async () => { throw new WebClientNotUpdatable('UNAUTHORIZED'); };
  const outcome = await reconcileWebClient(refused.account, savedClient,
    registeredClient({ grantTypes: ['authorization_code'] }));
  expect(outcome).toEqual({ case: 'reregistered', clientId: 'new-client', previousClientId: 'web-client',
    reason: 'it cannot be updated (UNAUTHORIZED)' });
  expect(webClientReconcileMessage(outcome)).toContain('cannot be updated (UNAUTHORIZED)');
  expect(refused.registrations).toHaveLength(1);
  const unavailable = fakeAccount();
  unavailable.account.updateClient = async () => { throw new Error('database unavailable'); };
  await expect(reconcileWebClient(unavailable.account, savedClient,
    registeredClient({ grantTypes: ['authorization_code'] }))).rejects.toThrow('database unavailable');
  expect(unavailable.registrations).toEqual([]);
  const halfUpdated = fakeAccount();
  halfUpdated.account.replaceInstallation = async () => { throw new Error('install failed'); };
  await expect(reconcileWebClient(halfUpdated.account, savedClient, registeredClient({
    installationScopes: siteScopes.filter(scope => scope !== 'follow:read') }))).rejects.toThrow('install failed');
  expect(halfUpdated.registrations).toEqual([]);
  expect(halfUpdated.updates).toHaveLength(1);
});
