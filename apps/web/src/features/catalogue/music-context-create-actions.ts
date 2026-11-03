import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import type { CreateResult, CreateSubjectCommand } from './create-subject';
import type { MusicContextCreateCommand } from './music-context-create';
import {
  createMusicContext,
  musicContextCreateUuid,
  type MusicContextCreateRead,
  readMusicContextCreate,
} from './music-context-create';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export const loadMusicContextCreate = createServerFn({ method: 'GET', strict: false })
  .validator((refresh: boolean = false) => refresh === true)
  .handler(async (): Promise<MusicContextCreateRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    return readMusicContextCreate(kernelClient());
  });

export const createCatalogueMusicContext = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((input: MusicContextCreateCommand): MusicContextCreateCommand => {
      if (
        !input ||
        !musicContextCreateUuid.test(input.key) ||
        !isRecord(input.item) ||
        typeof input.item.type !== 'string' ||
        Object.keys(input.item).some(
          (key) => !['type', 'labels', 'descriptions', 'aliases', 'statements'].includes(key),
        ) ||
        !isRecord(input.item.statements) ||
        Object.entries(input.item.statements).some(([property, rows]) =>
          !property || !Array.isArray(rows) || rows.some((row) => !isRecord(row)),
        )
      )
        throw new Error('Invalid music-context creation');
      return { key: input.key, item: input.item };
    }),
  )
  .handler(async ({ data }): Promise<CreateResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    setResponseHeader('cache-control', 'private, no-store');
    return createMusicContext(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      data,
      requestLocale() ?? 'en',
      authorization,
    );
  });
