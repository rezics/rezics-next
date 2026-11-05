import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { websiteRegistrationScopes, websiteRequestedScopes } from '../src/session/website-scopes.ts';
import { websiteWorkerScopes } from '../scripts/website-configuration.ts';

test('configured requests preserve exact action names and deduplicate OpenID scopes', () => {
  const scopes = websiteRegistrationScopes(['rating:vote', 'collection:update', 'rating:vote', 'openid']);
  expect(scopes).toEqual(['openid', 'offline_access', 'collection:update', 'rating:vote']);
  expect(websiteRequestedScopes(scopes.join(' '))).toBe(scopes.join(' '));
  expect(websiteRequestedScopes('openid offline_access media:read media:read')).toBe(
    'openid offline_access media:read',
  );
  expect(websiteRequestedScopes('openid media:read')).not.toContain('commerce_sale:list');
});

test('Worker configuration consumes registration output and refuses missing or mismatched deployment input', async () => {
  const dir = await mkdtemp(resolve(import.meta.dir, '../../../.temp/website-config-'));
  const file = resolve(dir, 'configuration.json');
  const scopes = websiteRegistrationScopes(['library_entry:list', 'rating:vote']).join(' ');
  try {
    await writeFile(file, JSON.stringify({ WEBSITE_SCOPES: scopes }));
    const env = { NODE_ENV: 'production', WEBSITE_CLIENT_ID: 'rezics-website', WEBSITE_CONFIGURATION_FILE: file };
    expect(websiteWorkerScopes(env)).toBe(scopes);
    expect(websiteWorkerScopes({ ...env, WEBSITE_SCOPES: scopes })).toBe(scopes);
    expect(() => websiteWorkerScopes({ ...env, WEBSITE_SCOPES: 'openid offline_access' })).toThrow('differs');
    expect(() => websiteWorkerScopes({ ...env, WEBSITE_CONFIGURATION_FILE: undefined })).toThrow('required');
    for (const bad of [
      {},
      { WEBSITE_SCOPES: 'openid offline_access *' },
      { WEBSITE_SCOPES: 'openid offline_access openid' },
    ]) {
      await writeFile(file, JSON.stringify(bad));
      expect(() => websiteWorkerScopes(env)).toThrow('Invalid WEBSITE_CONFIGURATION_FILE');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
