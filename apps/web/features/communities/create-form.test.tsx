import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createCommunityWithReadback, founderRealmAtHandle, initialCommunitySettings,
  profilePublicationOpensRealm, type CommunityCreationIntent, type FounderRealmRead } from './create-form.tsx';

type CreationResponse = Awaited<ReturnType<NonNullable<Parameters<typeof createCommunityWithReadback>[2]>>>;
const realm = 'https://rezics.com/id/00000000-0000-8000-8000-000000000412';
const rules = [{ id: 'respect', governanceRule: null,
  title: { original: 'ja', labels: { ja: '尊重' } }, body: { original: 'ja', labels: { ja: '読者を尊重する。' } } }];
const input: CommunityCreationIntent = { profile: 'space-realm-v2', name: 'Readers', language: 'ja',
  capabilities: ['realm'], handle: 'readers', actingSubject: realm,
  initialSettings: initialCommunitySettings('restricted', rules) };
const succeeded = { data: { realm }, error: null } as CreationResponse;

test('The restricted choice submits private disclosure and initial rules with admission in the create command', () => {
  expect(input.initialSettings).toEqual({ visibility: 'private', reviewRequired: true, reviewMode: 'mandatory',
    whoMaySubmit: 'granted', selfJoin: false, rules });
  expect(initialCommunitySettings('public', rules)).toEqual({ visibility: 'public', reviewRequired: false,
    reviewMode: 'open', whoMaySubmit: 'members', selfJoin: true, rules });
  const source = readFileSync(new URL('./create-form.tsx', import.meta.url), 'utf8');
  expect(source).not.toMatch(/\.management\.post|\.settings\.(get|put)/);
});

test('A lost creation response reads back the exact same intent and key without starting management steps', async () => {
  const requests: Array<{ body: CommunityCreationIntent; key: string }> = [];
  const result = await createCommunityWithReadback(input, 'creation-key', async (body, key) => {
    requests.push({ body, key });
    if (requests.length === 1) throw new Error('Response lost after commit');
    return succeeded;
  });
  expect(result).toBe(succeeded);
  expect(requests).toEqual([{ body: input, key: 'creation-key' }, { body: input, key: 'creation-key' }]);
});

test('Pending creation and unavailable initialization are read back once; definitive refusals are returned', async () => {
  for (const pending of [
    { data: { operationId: 'admission', status: 'reconciling' }, error: null },
    { data: null, error: { status: 503 } },
  ]) {
    let calls = 0;
    const result = await createCommunityWithReadback(input, 'creation-key', async () => {
      calls++;
      return calls === 1 ? pending as CreationResponse : succeeded;
    });
    expect(result).toBe(succeeded);
    expect(calls).toBe(2);
  }
  for (const status of [400, 403, 409]) {
    let calls = 0;
    const refused = { data: null, error: { status } } as CreationResponse;
    expect(await createCommunityWithReadback(input, 'creation-key', async () => { calls++; return refused; })).toBe(refused);
    expect(calls).toBe(1);
  }
});

test('Repeated lost responses surface recovery failure after one readback attempt', async () => {
  let calls = 0;
  await expect(createCommunityWithReadback(input, 'creation-key', async () => {
    calls++;
    throw new Error('Offline');
  })).rejects.toThrow('Offline');
  expect(calls).toBe(2);
});

const actor = 'https://rezics.com/id/00000000-0000-8000-8000-000000000410';
const owned = 'https://rezics.com/id/00000000-0000-8000-8000-000000000436';
const pageOf = (realms: readonly string[], nextCursor: string | null) => ({ realms, nextCursor });

test('The founder opens only a resolved Realm that their managed list names', async () => {
  const seen: Array<{ handle: string; actor: string; after: string | null }> = [];
  const read: FounderRealmRead = {
    resolve: async (handle, actingSubject) => {
      seen.push({ handle, actor: actingSubject, after: null });
      return handle === 'readers' ? owned : null;
    },
    managed: async (actingSubject, after) => {
      seen.push({ handle: '', actor: actingSubject, after });
      if (after === null) return pageOf(['https://rezics.com/id/00000000-0000-8000-8000-000000000001'], owned);
      return pageOf([owned], null);
    },
  };
  expect(await founderRealmAtHandle('readers', actor, read)).toBe(owned);
  expect(seen).toEqual([
    { handle: 'readers', actor, after: null },
    { handle: '', actor, after: null },
    { handle: '', actor, after: owned },
  ]);
  expect(await founderRealmAtHandle('missing', actor, read)).toBeNull();
});

test('A Realm the founder does not manage stays indistinguishable from a missing one', async () => {
  const other = 'https://rezics.com/id/00000000-0000-8000-8000-000000000999';
  let managedCalls = 0;
  const absent = await founderRealmAtHandle('taken', actor, {
    resolve: async () => other,
    managed: async () => { managedCalls++; return pageOf([], null); },
  });
  expect(absent).toBeNull();
  expect(managedCalls).toBe(1);
  expect(await founderRealmAtHandle('taken', actor, {
    resolve: async () => null,
    managed: async () => { throw new Error('The unresolved address has no list to read'); },
  })).toBeNull();
  expect(await founderRealmAtHandle('taken', actor, {
    resolve: async () => other,
    managed: async () => null,
  })).toBeNull();
});

test('Managed-Realm pages stop after the same bound Manage uses', async () => {
  let pages = 0;
  expect(await founderRealmAtHandle('readers', actor, {
    resolve: async () => owned,
    managed: async (_actor, after) => { pages++; return pageOf([], after ?? 'cursor'); },
  })).toBeNull();
  expect(pages).toBe(5);
});

test('A private Realm and an already published profile still open', () => {
  expect(profilePublicationOpensRealm('realm_unavailable')).toBe(true);
  expect(profilePublicationOpensRealm('stale_realm_profile')).toBe(true);
  expect(profilePublicationOpensRealm('invalid_realm_profile')).toBe(false);
  expect(profilePublicationOpensRealm(null)).toBe(false);
});
