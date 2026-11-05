import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient } from '../../../kernel/client';
import { fetchGuideRelease } from '../definition-guide';
import type { PersonDefinitions } from './model';

export const loadPersonDefinitions = createServerFn({ method: 'GET', strict: false })
  .validator((locale: string) => {
    if (!['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'].includes(locale))
      throw new Error('Invalid Person reader locale');
    return locale;
  })
  .handler(async ({ data }): Promise<PersonDefinitions | null> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const { types, properties } = await fetchGuideRelease(kernelClient(data));
      return { types, properties };
    } catch {
      return null;
    }
  });
