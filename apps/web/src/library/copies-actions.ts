import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import {
  loadCopiesPage,
  removeCopy,
  saveCopy,
  submitCopy,
  type CopiesPageData,
  type CopyRemoveResult,
  type CopyWriteResult,
} from './copies-read';

function validateQuery(input: unknown): { subjectId?: string; cursor?: string } {
  if (!input || typeof input !== 'object') return {};
  const record = input as Record<string, unknown>;
  const subjectId =
    typeof record.subjectId === 'string' && record.subjectId.length > 0 && record.subjectId.length <= 128
      ? record.subjectId
      : undefined;
  const cursor =
    typeof record.cursor === 'string' && record.cursor.length > 0 && record.cursor.length <= 2048
      ? record.cursor
      : undefined;
  return {
    ...(subjectId ? { subjectId } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export const readCopiesPage = createServerFn({ method: 'GET' })
  .validator(validateQuery)
  .handler(async ({ data }): Promise<CopiesPageData> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadCopiesPage(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const createCopy = createServerFn({ method: 'POST' })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<CopyWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return submitCopy(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const updateCopy = createServerFn({ method: 'POST' })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<CopyWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return saveCopy(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const deleteCopy = createServerFn({ method: 'POST' })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<CopyRemoveResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return removeCopy(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
