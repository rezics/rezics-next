import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appEnvironment, ensureSecrets, stackDirectory } from '../../../scripts/dev/config.ts';
import { grantPlatformUse, platformUsePermission } from '../fixtures/platform-grant.ts';

const roots: string[] = [];
mkdirSync('.temp', { recursive: true });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('appEnvironment designates a first administrator for dev and QA profiles only', () => {
  const root = mkdtempSync('.temp/platform-bootstrap-');
  roots.push(root);
  const dev = ensureSecrets(root, { profile: 'dev' });
  const qa = ensureSecrets(root, { profile: 'qa', runId: 'platform' });
  expect(dev.REZICS_STACK_PROFILE).toBe('dev');
  expect(qa.REZICS_STACK_PROFILE).toBe('qa');
  expect(ensureSecrets(root, { profile: 'dev' }).REZICS_STACK_PROFILE).toBe('dev');
  const devDir = stackDirectory(root, { profile: 'dev' });
  const devPath = join(devDir, 'compose.env');
  writeFileSync(devPath, readFileSync(devPath, 'utf8').replace('REZICS_STACK_PROFILE=dev', 'REZICS_STACK_PROFILE=qa'),
    { mode: 0o600 });
  expect(ensureSecrets(root, { profile: 'dev' }).REZICS_STACK_PROFILE).toBe('qa');
  writeFileSync(devPath, readFileSync(devPath, 'utf8').replace(/^REZICS_STACK_PROFILE=.*\n/m, ''), { mode: 0o600 });
  const restored = ensureSecrets(root, { profile: 'dev' });
  expect(restored.REZICS_STACK_PROFILE).toBe('dev');

  const subject = 'local-member';
  const devApps = appEnvironment({ ...restored, PLATFORM_FIRST_ADMIN_ACCOUNT: subject }, devDir);
  expect(devApps.PLATFORM_FIRST_ADMIN_ACCOUNT).toBe(subject);
  expect(appEnvironment({ ...qa, PLATFORM_FIRST_ADMIN_ACCOUNT: subject }, root).PLATFORM_FIRST_ADMIN_ACCOUNT)
    .toBe(subject);
  expect(appEnvironment(restored, devDir).PLATFORM_FIRST_ADMIN_ACCOUNT).toBeUndefined();
  const withoutProfile = { ...restored, PLATFORM_FIRST_ADMIN_ACCOUNT: subject };
  delete withoutProfile.REZICS_STACK_PROFILE;
  expect(appEnvironment(withoutProfile, devDir).PLATFORM_FIRST_ADMIN_ACCOUNT).toBeUndefined();
  expect(appEnvironment({ ...restored, REZICS_STACK_PROFILE: 'production',
    PLATFORM_FIRST_ADMIN_ACCOUNT: subject }, devDir).PLATFORM_FIRST_ADMIN_ACCOUNT).toBeUndefined();
  expect(appEnvironment({ ...restored, REZICS_STACK_PROFILE: 'production',
    PLATFORM_FIRST_ADMIN_ACCOUNT: 'not a subject' }, devDir).PLATFORM_FIRST_ADMIN_ACCOUNT).toBeUndefined();
  expect(() => appEnvironment({ ...restored, PLATFORM_FIRST_ADMIN_ACCOUNT: 'has space' }, devDir))
    .toThrow('Invalid PLATFORM_FIRST_ADMIN_ACCOUNT');
  expect(() => appEnvironment({ ...qa, PLATFORM_FIRST_ADMIN_ACCOUNT: `${'a'.repeat(257)}` }, root))
    .toThrow('Invalid PLATFORM_FIRST_ADMIN_ACCOUNT');
  expect(appEnvironment({ ...restored, PLATFORM_FIRST_ADMIN_ACCOUNT: 'a'.repeat(256) }, devDir)
    .PLATFORM_FIRST_ADMIN_ACCOUNT).toHaveLength(256);
});

test('opening a closed group rejects a group id before any request', async () => {
  expect(platformUsePermission('saved-views')).toBe('platform:use:saved-views');
  const session = { mainOrigin: 'http://127.0.0.1:9', token: 'unused',
    actingSubject: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
    principalId: '00000000-0000-4000-8000-000000000002' };
  await expect(grantPlatformUse(session, session.principalId, 'Saved-Views')).rejects.toThrow('exposure group');
  await expect(grantPlatformUse(session, session.principalId, 'saved_views')).rejects.toThrow('exposure group');
  await expect(grantPlatformUse(session, 'not-a-principal', 'saved-views')).rejects.toThrow('principal id');
});
