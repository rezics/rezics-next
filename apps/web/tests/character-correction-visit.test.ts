import { expect, mock, test } from 'bun:test';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const { characterAddress } = await import('../src/features/catalogue/character-profile-actions');

import type { KernelClient } from '@rezics/client';
import { candidateContext } from '../src/subject/candidates';
import {
  characterPublicReturnHref,
  globalCharacterCorrectionHref,
  parseCharacterCorrectionSearch,
  parseCharacterCorrectionUrl,
} from '../src/features/catalogue/character-correction-visit';
import {
  characterUuid,
  isCurrentCharacterRead,
  readCharacterProfile,
} from '../src/features/catalogue/character-profile';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';
import { characterProfileFixture, characterProfileId } from '../src/kernel/fake/catalogue-character-profile';

const contextA = '019a1b2c-3d4e-7f00-8a00-000000000011';
const realmA = '019a1b2c-3d4e-7f00-8a00-000000000022';
const realmB = '019a1b2c-3d4e-7f00-8a00-000000000033';
const handoff = '019a1b2c-3d4e-7f00-8a00-000000000055';

test('Character correction address and native read retain exact Context and Realm, while Global remains a fresh visit', async () => {
  const fixture = characterProfileFixture();
  const workId = fixture.work.id;
  const parsed = parseCharacterCorrectionSearch({ context: contextA, realm: realmA, work: workId });
  expect(parsed).toEqual({ ok: true, value: { context: contextA, realm: realmA, work: workId } });
  expect(parseCharacterCorrectionUrl(`?context=${contextA}&realm=${realmA}&work=${workId}`).ok).toBe(true);
  expect(parseCharacterCorrectionUrl(`?context=${contextA}&context=${realmA}&realm=${realmA}`).ok).toBe(false);
  expect(parseCharacterCorrectionUrl(`?realm=${realmA}`).ok).toBe(true);
  expect(characterUuid.test(characterProfileId)).toBe(true);
  expect(
    characterAddress({ id: characterProfileId, work: workId, context: contextA, realm: realmA }),
  ).toEqual({ id: characterProfileId, work: workId, context: contextA, realm: realmA });

  const entry = catalogueEntries.character({
    id: characterProfileId,
    label: 'The traveler',
    locale: 'en',
    work: workId,
    context: contextA,
    realm: realmA,
  });
  const entryUrl = new URL(entry.href, 'https://site.test');
  expect(Object.fromEntries(entryUrl.searchParams)).toEqual({ work: workId, context: contextA, realm: realmA });

  fixture.character.subject.context = contextA;
  const requests: { id: string; context?: string }[] = [];
  const client = {
    definitions: fixture.client.definitions,
    definitionTypes: fixture.client.definitionTypes,
    subjects: ({ id }: { id: string }) => {
      const endpoint = fixture.client.subjects({ id });
      return {
        get: async (input?: { query?: { context?: string } }) => {
          requests.push({ id, context: input?.query?.context });
          return endpoint.get(input);
        },
      };
    },
  } as unknown as KernelClient;
  const read = await readCharacterProfile(
    client,
    { id: characterProfileId, work: workId, context: contextA, realm: realmA },
  );
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error('Expected the selected Character reading');
  expect(read.context).toBe(contextA);
  expect(read.realm).toBe(realmA);
  expect(read.character?.subject.context).toBe(contextA);
  expect(requests).toEqual([
    { id: characterProfileId, context: contextA },
    { id: workId, context: undefined },
  ]);
  expect(isCurrentCharacterRead(read, { isSuccess: true, isFetching: false }, { id: characterProfileId, work: workId, context: contextA, realm: realmA })).toBe(true);
  expect(isCurrentCharacterRead(read, { isSuccess: true, isFetching: false }, { id: characterProfileId, work: workId, context: contextA, realm: realmB })).toBe(false);
  expect(isCurrentCharacterRead(read, { isSuccess: true, isFetching: false }, { id: characterProfileId, work: workId, context: candidateContext, realm: realmA })).toBe(false);

  const globalHref = globalCharacterCorrectionHref({
    id: characterProfileId,
    label: 'The traveler',
    locale: 'en',
    work: workId,
    classificationHandoff: handoff,
  });
  const globalUrl = new URL(globalHref, 'https://site.test');
  expect(globalUrl.searchParams.get('context')).toBe(candidateContext);
  expect(globalUrl.searchParams.get('realm')).toBeNull();
  expect(globalUrl.searchParams.get('work')).toBe(workId);
  expect(globalUrl.searchParams.get('classificationHandoff')).toBe(handoff);
  expect(characterPublicReturnHref({ id: characterProfileId, label: 'The traveler', locale: 'en', context: contextA })).toBeUndefined();
  expect(characterPublicReturnHref({ id: characterProfileId, label: 'The traveler', locale: 'en', context: contextA, realm: realmA }))
    ?.endsWith(`?realm=${realmA}`).toBe(true);
});
