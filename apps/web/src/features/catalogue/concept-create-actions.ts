import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import type { CreateResult, CreateSubjectCommand } from './create-subject';
import type { ConceptCreateCommand } from './concept-create';
import {
  createConceptSubject,
  conceptCreateUuid,
  type ConceptCreateRead,
  readConceptCreate,
} from './concept-create';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export const loadConceptCreate = createServerFn({ method: 'GET', strict: false })
  .validator((refresh: boolean = false) => refresh === true)
  .handler(async (): Promise<ConceptCreateRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    return readConceptCreate(kernelClient());
  });

export const createCatalogueConcept = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((input: ConceptCreateCommand): ConceptCreateCommand => {
      if (
        !input ||
        !conceptCreateUuid.test(input.key) ||
        !isRecord(input.item) ||
        typeof input.item.type !== 'string' ||
        Object.keys(input.item).some(
          (key) => !['type', 'labels', 'descriptions', 'aliases', 'statements'].includes(key),
        ) ||
        (input.item.statements !== undefined &&
          (!isRecord(input.item.statements) ||
            Object.entries(input.item.statements).some(
              ([property, rows]) => !property || !Array.isArray(rows) || rows.some((row) => !isRecord(row)),
            )))
      )
        throw new Error('Invalid concept creation');
      return { key: input.key, item: input.item };
    }),
  )
  .handler(async ({ data }): Promise<CreateResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    setResponseHeader('cache-control', 'private, no-store');
    return createConceptSubject(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      data as CreateSubjectCommand,
      requestLocale() ?? 'en',
      authorization,
    );
  });
