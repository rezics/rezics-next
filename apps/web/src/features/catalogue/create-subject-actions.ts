import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { readRelease, refreshRelease } from '../../subject/definitions';
import {
  createTypes,
  type CreateDefinitions,
  type CreateResult,
  type CreateSubjectCommand,
  type CreatedReader,
} from './create-subject';
import { createSubjectRecord, readCreatedSubject } from './create-subject-request';

export const readCreateDefinitions = createServerFn({ method: 'GET' })
  .validator((refresh: boolean = false) => refresh === true)
  .handler(async ({ data }): Promise<CreateDefinitions> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      return { ok: true, types: createTypes(await (data ? refreshRelease() : readRelease()), requestLocale() ?? 'en') };
    } catch {
      return { ok: false };
    }
  });

export const createCatalogueSubject = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((input: CreateSubjectCommand): CreateSubjectCommand => {
      if (!input || typeof input.key !== 'string' || !input.item || typeof input.item.type !== 'string')
        throw new Error('Invalid subject request');
      // Initial terms only: never admit statements, caller-selected IDs or custom definitions through this form.
      return {
        key: input.key,
        item: {
          type: input.item.type,
          labels: input.item.labels,
          ...(input.item.descriptions === undefined ? {} : { descriptions: input.item.descriptions }),
          ...(input.item.aliases === undefined ? {} : { aliases: input.item.aliases }),
        },
      };
    }),
  )
  .handler(async ({ data }): Promise<CreateResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    setResponseHeader('cache-control', 'private, no-store');
    return createSubjectRecord(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      data,
      requestLocale() ?? 'en',
      authorization,
    );
  });

export const readCreatedCatalogueSubject = createServerFn({ method: 'GET' })
  .validator((id: string) => (typeof id === 'string' && id.length <= 128 ? id : ''))
  .handler(async ({ data }): Promise<CreatedReader> => {
    setResponseHeader('cache-control', 'private, no-store');
    return readCreatedSubject(kernelClient(), data, requestLocale() ?? 'en');
  });
