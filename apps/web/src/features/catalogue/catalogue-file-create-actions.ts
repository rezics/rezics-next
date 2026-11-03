import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import type { CreateResult } from './create-subject';
import type { CatalogueFileCreateCommand } from './catalogue-file-create';
import {
  catalogueFileCreateUuid,
  createCatalogueFile,
  type CatalogueFileCreateRead,
  readCatalogueFileCreate,
} from './catalogue-file-create';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export const loadCatalogueFileCreate = createServerFn({ method: 'GET', strict: false })
  .validator((refresh: boolean = false) => refresh === true)
  .handler(async (): Promise<CatalogueFileCreateRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    return readCatalogueFileCreate(kernelClient());
  });

export const createCatalogueFileSubject = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((input: CatalogueFileCreateCommand): CatalogueFileCreateCommand => {
      if (
        !input ||
        !catalogueFileCreateUuid.test(input.key) ||
        !isRecord(input.item) ||
        typeof input.item.type !== 'string' ||
        Object.keys(input.item).some(
          (key) => !['type', 'labels', 'descriptions', 'aliases', 'statements'].includes(key),
        ) ||
        !isRecord(input.item.statements) ||
        Object.entries(input.item.statements).some(
          ([property, rows]) => !property || !Array.isArray(rows) || rows.some((row) => !isRecord(row)),
        )
      )
        throw new Error('Invalid catalogue-file creation');
      return { key: input.key, item: input.item };
    }),
  )
  .handler(async ({ data }): Promise<CreateResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    setResponseHeader('cache-control', 'private, no-store');
    return createCatalogueFile(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      data,
      requestLocale() ?? 'en',
      authorization,
    );
  });
