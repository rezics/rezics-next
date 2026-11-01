import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { createLiteraryWork, readLiteraryProfile, type LiteraryCommand, type LiteraryRead } from './literary-profile';
import type { CreateResult } from './create-subject';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const loadLiteraryProfile = createServerFn({ method: 'GET', strict: false })
  .validator((id?: string) => {
    if (id !== undefined && (typeof id !== 'string' || !uuid.test(id))) throw new Error('Invalid work identity');
    return id;
  })
  .handler(async ({ data }): Promise<LiteraryRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    return readLiteraryProfile(kernelClient(), data);
  });
export const createCatalogueLiteraryWork = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput((command: LiteraryCommand) => {
    if (!command || typeof command.key !== 'string' || !uuid.test(command.key) || !command.item)
      throw new Error('Invalid work request');
    // The shared release validator rejects unknown fields, including ingestion Source metadata.
    return { key: command.key, item: command.item };
  }))
  .handler(async ({ data }): Promise<CreateResult> => {
    if (!(await candidateAuthorization(data.expectedReader))) return { ok: false, reason: 'denied' };
    setResponseHeader('cache-control', 'private, no-store');
    return createLiteraryWork(kernelClient(), getRequest(), env as Partial<SessionEnv>, data, requestLocale() ?? 'en');
  });
