import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import {
  albumType,
  albumUuid,
  createAlbum,
  readAlbumProfile,
  type AlbumCommand,
  type AlbumRead,
} from './album-profile';
import type { CreateResult } from './create-subject';

export const loadAlbumProfile = createServerFn({ method: 'GET', strict: false })
  .validator((id?: string) => (id === undefined || (typeof id === 'string' && albumUuid.test(id)) ? id : ''))
  .handler(async ({ data }): Promise<AlbumRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    return readAlbumProfile(kernelClient(), data);
  });

export const createCatalogueAlbum = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput((input: AlbumCommand): AlbumCommand => {
    if (!input || !albumUuid.test(input.key) || !input.item || input.item.type !== albumType)
      throw new Error('Invalid album request');
    return { key: input.key, item: input.item };
  }))
  .handler(async ({ data }): Promise<CreateResult> => {
    if (!(await candidateAuthorization(data.expectedReader))) return { ok: false, reason: 'denied' };
    setResponseHeader('cache-control', 'private, no-store');
    return createAlbum(kernelClient(), getRequest(), env as Partial<SessionEnv>, data, requestLocale() ?? 'en');
  });
