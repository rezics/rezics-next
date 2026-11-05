import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import {
  createPublication,
  publicationUuid,
  readPublicationEditor,
  type PublicationCommand,
  type PublicationRead,
} from './publication-editor';
import type { CreateResult } from './create-subject';

export const loadPublicationEditor = createServerFn({ method: 'GET', strict: false })
  .validator((id: string) => (typeof id === 'string' && publicationUuid.test(id) ? id : ''))
  .handler(async ({ data }): Promise<PublicationRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    return readPublicationEditor(kernelClient(), data, requestLocale() ?? 'en');
  });

export const createWorkPublication = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((input: PublicationCommand): PublicationCommand => {
      if (
        !input ||
        !publicationUuid.test(input.work) ||
        !publicationUuid.test(input.key) ||
        typeof input.relation !== 'string' ||
        input.relation.length > 256 ||
        !input.item ||
        typeof input.item.type !== 'string'
      )
        throw new Error('Invalid publication request');
      return { work: input.work, relation: input.relation, key: input.key, item: input.item };
    }),
  )
  .handler(async ({ data }): Promise<CreateResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    setResponseHeader('cache-control', 'private, no-store');
    try {
      return await createPublication(
        kernelClient(),
        getRequest(),
        env as Partial<SessionEnv>,
        data,
        requestLocale() ?? 'en',
        authorization,
      );
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  });
