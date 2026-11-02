import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import {
  createCharacter,
  readCharacterProfile,
  characterType,
  characterUuid,
  type CharacterAddress,
  type CharacterCommand,
  type CharacterRead,
} from './character-profile';
import type { CreateResult } from './create-subject';

export function characterAddress(input: CharacterAddress): CharacterAddress {
  if (
    !input ||
    [input.id, input.work].some((id) => id !== undefined && (typeof id !== 'string' || !characterUuid.test(id)))
  )
    throw new Error('Invalid character address');
  return { ...(input.id ? { id: input.id } : {}), ...(input.work ? { work: input.work } : {}) };
}
export const loadCharacterProfile = createServerFn({ method: 'GET', strict: false })
  .validator(characterAddress)
  .handler(async ({ data }): Promise<CharacterRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    return readCharacterProfile(kernelClient(), data, requestLocale() ?? 'en');
  });
export const createCatalogueCharacter = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((input: CharacterCommand): CharacterCommand => {
      if (
        !input ||
        !characterUuid.test(input.key) ||
        !input.item ||
        input.item.type !== characterType ||
        !input.item.statements ||
        Object.keys(input.item).some(
          (key) => !['type', 'labels', 'descriptions', 'aliases', 'statements'].includes(key),
        )
      )
        throw new Error('Invalid character creation');
      return { key: input.key, item: input.item };
    }),
  )
  .handler(async ({ data }): Promise<CreateResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    setResponseHeader('cache-control', 'private, no-store');
    return createCharacter(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      data,
      requestLocale() ?? 'en',
      authorization,
    );
  });
