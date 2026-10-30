import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { readSubjectSources, type SourcesResult } from './subject-sources';

export const loadSubjectSources = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; locale: string }) => {
    if (!input || typeof input.id !== 'string' || input.id.length > 128 || typeof input.locale !== 'string' || input.locale.length > 35)
      throw new Error('Invalid subject sources request');
    return { id: input.id, locale: input.locale };
  })
  .handler(async ({ data }): Promise<SourcesResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const [{ kernelClient }, { readRelease }] = await Promise.all([
      import('../../kernel/client'), import('../../subject/definitions'),
    ]);
    // Start independent reads together; missing labels must not hide permitted citations.
    const definitions = readRelease().catch(() => undefined);
    return readSubjectSources(kernelClient(data.locale), data.id, data.locale, definitions);
  });
