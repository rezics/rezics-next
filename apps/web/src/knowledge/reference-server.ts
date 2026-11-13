import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient } from '../kernel/client';
import { parseReferenceTarget } from './reference-model';
import { inspectKnowledgeReference } from './reference-read';

export const inspectKnowledgePublicReferenceRequest = createServerFn({ method: 'GET' })
  .validator((value: unknown) => {
    if (typeof value !== 'object' || value === null) throw new Error('Invalid Knowledge reference inspection');
    const input = value as Record<string, unknown>;
    const target = parseReferenceTarget(input.target);
    if (!target || typeof input.locale !== 'string' || input.locale.length < 1 || input.locale.length > 64)
      throw new Error('Invalid Knowledge reference inspection');
    return { target, locale: input.locale, notebookId: null };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return inspectKnowledgeReference(kernelClient(data.locale), data);
  });
