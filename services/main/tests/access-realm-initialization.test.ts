import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { AccessRealmManagement, type RealmInitializationInput } from '../src/modules/access/realm-management.ts';
import { RealmAdminInvalid } from '../src/modules/realm-admin/contract.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { initialRealmPolicyFacts } from '../src/modules/access/realm-initialization.ts';
import { reviewPolicy } from '../src/modules/space/policy.ts';

const input: RealmInitializationInput = {
  realm: 'https://rezics.com/id/00000000-0000-8000-8000-000000000001',
  actingSubject: 'https://rezics.com/id/00000000-0000-8000-8000-000000000002',
  creationKey: 'creation-key', creationDigest: 'a'.repeat(64),
  policyReceipt: '00000000-0000-8000-8000-000000000003',
  settings: { visibility: 'private', reviewRequired: true, whoMaySubmit: 'members', selfJoin: false },
};

test('Created Realm initialization rejects malformed bindings and uses the existing settings schema before storage', async () => {
  let calls = 0;
  const management = new AccessRealmManagement({ connect: () => { calls++; throw new Error('unexpected storage'); } } as unknown as Pool);
  const env = {} as WorkActivationEnvironment;
  for (const change of [
    { realm: 'not-a-realm' }, { actingSubject: 'not-an-agent' }, { creationKey: '' },
    { creationKey: 'x'.repeat(129) }, { creationDigest: 'not-a-digest' },
    { policyReceipt: undefined }, { policyReceipt: '' }, { policyReceipt: 'not-a-uuid' },
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

test('Initial policy facts preserve creation settings, unified policy defaults and a stable receipt', () => {
  for (const visibility of ['public', 'restricted', 'private'] as const) {
    for (const reviewMode of ['open', 'trusted-members', 'mandatory'] as const) {
      for (const selfJoin of [false, true]) {
        const creation = { ...input, settings: { ...input.settings, visibility, reviewMode,
          reviewRequired: reviewMode === 'mandatory', selfJoin } };
        const facts = initialRealmPolicyFacts(creation, input.actingSubject);
        expect(facts.revision).toBe(`urn:rezics:realm-policy:${input.policyReceipt}`);
        expect(facts.current).toContain(`rv:realmPolicyHead <${facts.revision}>`);
        expect(facts.current).toContain(`rv:reviewPolicy <${reviewPolicy(reviewMode)}>`);
        expect(facts.current).toContain(`rv:visibility "${visibility}" ; rv:reviewMode "${reviewMode}"`);
        expect(facts.current).toContain(`rv:disclosure rv:${visibility === 'private' ? 'Private' : 'Public'}`);
        expect(facts.current).toContain('rv:listing "listed"');
        expect(facts.current).toContain(`rv:historyVisibility "everything" ; rv:admissionMode "${selfJoin ? 'open' : 'invitation'}"`);
        expect(facts.receipt).toContain(`<${facts.revision}> a rv:OperationReceipt ; rv:outcome rv:Succeeded`);
        expect(facts.receipt).toContain(`rv:requestDigest "${input.creationDigest}"`);
        expect(facts.receipt).toContain('rv:policyGeneration "1"');
        expect(initialRealmPolicyFacts(creation, input.actingSubject)).toEqual(facts);
      }
    }
  }
  expect(initialRealmPolicyFacts({ ...input, settings: { ...input.settings, reviewRequired: false } }, input.actingSubject)
    .current).toContain('rv:reviewMode "open"');
  expect(() => initialRealmPolicyFacts({ ...input, policyReceipt: '' }, input.actingSubject)).toThrow(RealmAdminInvalid);
  expect(() => initialRealmPolicyFacts({ ...input, settings: { ...input.settings, reviewMode: 'open' } }, input.actingSubject))
    .toThrow('Review mode and reviewRequired disagree');
});
