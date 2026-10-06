import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createCommunityWithReadback, initialCommunitySettings, type CommunityCreationIntent } from './create-form.tsx';

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
