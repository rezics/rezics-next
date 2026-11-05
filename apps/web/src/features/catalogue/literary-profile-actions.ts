import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import {
  createLiteraryWork,
  isLiteraryType,
  readLiteraryProfile,
  type LiteraryCommand,
  type LiteraryRead,
} from './literary-profile';
import type { CreateResult } from './create-subject';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const loadLiteraryProfile = createServerFn({ method: 'GET', strict: false })
  .validator((input?: string | { id: string; type: string }) => {
    const id = typeof input === 'object' && input ? input.id : input;
    if (id !== undefined && (typeof id !== 'string' || !uuid.test(id))) throw new Error('Invalid work identity');
    if (
      typeof input === 'object' &&
      (!input ||
        !uuid.test(input.id) ||
        Object.keys(input).some((key) => !['id', 'type'].includes(key)) ||
        !isLiteraryType(input.type))
    )
      throw new Error('Invalid work type');
    return input;
  })
  .handler(async ({ data }): Promise<LiteraryRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const result = await readLiteraryProfile(kernelClient(), typeof data === 'object' ? data.id : data);
    if (typeof data === 'object' && result.ok && result.current?.public.subject.type !== data.type)
      return { ok: false, reason: 'stale' };
    return result;
  });

export const createCatalogueLiteraryWork = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((command: LiteraryCommand) => {
      if (!command || typeof command.key !== 'string' || !uuid.test(command.key) || !command.item)
        throw new Error('Invalid work request');
      // The shared release validator rejects unknown fields, including ingestion Source metadata.
      return { key: command.key, item: command.item };
    }),
  )
  .handler(async ({ data }): Promise<CreateResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    setResponseHeader('cache-control', 'private, no-store');
    return createLiteraryWork(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      data,
      requestLocale() ?? 'en',
      authorization,
    );
  });
