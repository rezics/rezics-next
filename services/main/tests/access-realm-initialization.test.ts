import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { AccessRealmManagement, type RealmInitializationInput } from '../src/modules/access/realm-management.ts';
import { RealmAdminInvalid } from '../src/modules/realm-admin/contract.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const input: RealmInitializationInput = {
  realm: 'https://rezics.com/id/00000000-0000-8000-8000-000000000001',
  actingSubject: 'https://rezics.com/id/00000000-0000-8000-8000-000000000002',
  creationKey: 'creation-key', creationDigest: 'a'.repeat(64),
  settings: { visibility: 'private', reviewRequired: true, whoMaySubmit: 'members', selfJoin: false },
};

test('Created Realm initialization rejects malformed bindings and uses the existing settings schema before storage', async () => {
  let calls = 0;
  const management = new AccessRealmManagement({ connect: () => { calls++; throw new Error('unexpected storage'); } } as unknown as Pool);
  const env = {} as WorkActivationEnvironment;
  for (const change of [
    { realm: 'not-a-realm' }, { actingSubject: 'not-an-agent' }, { creationKey: '' },
    { creationKey: 'x'.repeat(129) }, { creationDigest: 'not-a-digest' },
    { settings: { ...input.settings, visibility: 'hidden' } },
    { settings: { ...input.settings, reviewMode: 'automatic' } },
    { settings: { ...input.settings, whoMaySubmit: 'anyone' } },
    { rules: null },
    { rules: Array.from({ length: 13 }, () => ({ id: 'rule', title: { original: 'en', labels: { en: 'Title' } },
      body: { original: 'en', labels: { en: 'Body' } }, governanceRule: null })) },
  ]) {
    await expect(management.initializeCreated({ issuer: 'test', subject: 'creator' },
      { ...input, ...change } as RealmInitializationInput, env)).rejects.toBeInstanceOf(RealmAdminInvalid);
  }
  expect(calls).toBe(0);
});
