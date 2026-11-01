import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import type { CreateResult } from './create-subject';
import {
  createPeopleProfile,
  peopleUuid,
  readPeopleProfile,
  type PeopleAddress,
  type PeopleCommand,
  type PeopleRead,
} from './people-profile';

export const loadPeopleProfile = createServerFn({ method: 'GET', strict: false })
  .validator((input: PeopleAddress): PeopleAddress => {
    if (
      !input ||
      Object.keys(input).some((key) => key !== 'id' && key !== 'work') ||
      [input.id, input.work].some((id) => id !== undefined && (typeof id !== 'string' || !peopleUuid.test(id)))
    )
      throw new Error('Invalid catalogue profile address');
    return input;
  })
  .handler(async ({ data }): Promise<PeopleRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    return readPeopleProfile(kernelClient(), requestLocale() ?? 'en', data);
  });

export const createCataloguePeopleProfile = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((input: PeopleCommand): PeopleCommand => {
      if (
        !input ||
        typeof input.key !== 'string' ||
        !peopleUuid.test(input.key) ||
        !input.item ||
        typeof input.item.type !== 'string' ||
        Object.keys(input).some((key) => key !== 'key' && key !== 'item')
      )
        throw new Error('Invalid catalogue profile request');
      return { key: input.key, item: input.item };
    }),
  )
  .handler(async ({ data }): Promise<CreateResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    setResponseHeader('cache-control', 'private, no-store');
    return createPeopleProfile(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      data,
      requestLocale() ?? 'en',
      authorization,
    );
  });
