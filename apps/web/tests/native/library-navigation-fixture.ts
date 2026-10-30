import { expect } from 'bun:test';
import type { NativeWebStack } from './stack.ts';

export async function createLibraryEntry(stack: NativeWebStack, persona: string, authorization: string) {
  const openedLibrary = await stack.kernel(
    '/v1/platform/exposure/personal_library:open',
    { method: 'POST', headers: { 'idempotency-key': `"${crypto.randomUUID()}"` } },
    'governor',
  );
  expect(openedLibrary.status).toBe(200);

  const createdSubject = await stack.kernel(
    '/v1/subjects',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
      body: JSON.stringify({ type: 'schema:Book', labels: { en: 'Native library member' } }),
    },
    'editor',
  );
  expect(createdSubject.status).toBe(201);
  const { subject } = (await createdSubject.json()) as { subject: { id: string } };
  const activeDefinition = await stack.kernel('/v1/definitions/active');
  expect(activeDefinition.status).toBe(200);
  const { digest } = (await activeDefinition.json()) as { digest: string };
  const releasedDefinition = await stack.kernel(`/v1/definitions/releases/${encodeURIComponent(digest)}`);
  expect(releasedDefinition.status).toBe(200);
  const releaseBody = (await releasedDefinition.json()) as {
    release: {
      types: Record<string, { library?: { profileId?: string } }>;
      libraryProfiles: Record<string, { entryStateSet?: { states: { id: string; role: string }[] } }>;
    };
  };
  const profileId = releaseBody.release.types['schema:Book']?.library?.profileId;
  expect(profileId, 'the accepted Book type names its actual Library profile').toBeDefined();
  const activeState = releaseBody.release.libraryProfiles[profileId!]?.entryStateSet?.states.find(
    (state) => state.role === 'active',
  );
  expect(activeState, 'the accepted Library profile has its active state').toBeDefined();
  const entry = await stack.kernel(
    `/v1/libraryEntries/${subject.id}`,
    {
      method: 'PUT',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `"${crypto.randomUUID()}"`,
      },
      body: JSON.stringify({ state: activeState!.id }),
    },
    persona,
  );
  expect(entry.status, 'the reader creates the private state through the documented Library API').toBe(201);
  return subject;
}

export async function createLibraryNavigationFixture(stack: NativeWebStack) {
  const owner = await stack.authPersona('alice');
  const reader = await stack.authPersona('bob');
  const subject = await createLibraryEntry(stack, 'bob', reader.authorization);

  const result = await stack.kernel(
    '/v1/collections',
    {
      method: 'POST',
      headers: {
        authorization: owner.authorization,
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({ title: 'Native navigation list', visibility: 'public' }),
    },
    'alice',
  );
  expect(result.status).toBe(201);
  const { collection } = (await result.json()) as { collection: { id: string; revision: number } };

  const pins = await stack.kernel(
    '/v1/libraryPins?limit=100',
    {
      headers: { authorization: reader.authorization },
    },
    'bob',
  );
  expect(pins.status, 'the active native runtime must expose the documented pins list').toBe(200);
  const pinList = (await pins.json()) as { revision: number };
  const pinned = await stack.kernel(
    `/v1/libraryPins/${collection.id}`,
    {
      method: 'PUT',
      headers: {
        authorization: reader.authorization,
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({ revision: pinList.revision, after: null }),
    },
    'bob',
  );
  expect(pinned.status, 'the curated Collection must be pinned through the real native API').toBe(200);

  return { owner, reader, collection, memberSubject: subject };
}
