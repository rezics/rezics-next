import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import {
  createManga,
  isMangaType,
  mangaUuid,
  readMangaProfile,
  type MangaCommand,
  type MangaRead,
} from './manga-profile';
import type { CreateResult } from './create-subject';

export const loadMangaProfile = createServerFn({ method: 'GET', strict: false })
  .validator((id?: string) => (id === undefined || (typeof id === 'string' && mangaUuid.test(id)) ? id : ''))
  .handler(async ({ data }): Promise<MangaRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    return readMangaProfile(kernelClient(), data);
  });
export const createCatalogueManga = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((input: MangaCommand): MangaCommand => {
      if (
        !input ||
        !mangaUuid.test(input.key) ||
        !input.item ||
        !isMangaType(input.item.type) ||
        typeof input.independent !== 'boolean'
      )
        throw new Error('Invalid manga creation');
      return { key: input.key, item: input.item, independent: input.independent };
    }),
  )
  .handler(async ({ data }): Promise<CreateResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    setResponseHeader('cache-control', 'private, no-store');
    return createManga(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      data,
      requestLocale() ?? 'en',
      authorization,
    );
  });
