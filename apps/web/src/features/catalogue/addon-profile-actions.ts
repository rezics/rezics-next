import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import type { CreateResult, CreateSubjectCommand } from './create-subject';
import {
  addonType,
  addonUuid,
  createAddon,
  readAddonProfile,
  type AddonAddress,
  type AddonRead,
} from './addon-profile';

export const loadAddonProfile = createServerFn({ method: 'GET', strict: false })
  .validator((input: AddonAddress): AddonAddress => {
    if (
      !input ||
      [input.id, input.work].some((id) => id !== undefined && (typeof id !== 'string' || !addonUuid.test(id)))
    )
      throw new Error('Invalid add-on address');
    return { id: input.id, work: input.work };
  })
  .handler(async ({ data }): Promise<AddonRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    return readAddonProfile(kernelClient(), data);
  });
export const createCatalogueAddon = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((input: CreateSubjectCommand): CreateSubjectCommand => {
      if (
        !input ||
        !addonUuid.test(input.key) ||
        !input.item ||
        input.item.type !== addonType ||
        Object.keys(input.item).some(
          (key) => !['type', 'labels', 'descriptions', 'aliases', 'statements'].includes(key),
        )
      )
        throw new Error('Invalid add-on creation');
      return { key: input.key, item: input.item };
    }),
  )
  .handler(async ({ data }): Promise<CreateResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    setResponseHeader('cache-control', 'private, no-store');
    return createAddon(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      data,
      requestLocale() ?? 'en',
      authorization,
    );
  });
