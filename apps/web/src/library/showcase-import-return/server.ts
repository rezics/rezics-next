import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { validExpectedReader, type ExpectedReader } from '../../session/expected-reader';
import { loadImportLibrary, validImportLibraryCursor, type ImportLibraryRequest } from './read';
import { importLibraryLabels } from './presentation';
import { readRelease } from '../../subject/definitions';

export const readImportLibrary = createServerFn({ method: 'GET' })
  .validator((input: unknown): ImportLibraryRequest => {
    if (!validExpectedReader(input)) throw new Error('Invalid Library return');
    const cursor = (input as ExpectedReader & { cursor?: unknown }).cursor;
    if (!validImportLibraryCursor(cursor)) throw new Error('Invalid Library cursor');
    return {
      expectedReader: input.expectedReader,
      expectedCredential: input.expectedCredential,
      ...(cursor === undefined ? {} : { cursor }),
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const locale = requestLocale(request) ?? 'en';
    const result = await loadImportLibrary(kernelClient(locale), request, env as Partial<SessionEnv>, data, data.cursor);
    if (result.state !== 'current') return result;
    const release = await readRelease().catch(() => undefined);
    return { ...result, labels: importLibraryLabels(result.page, locale, release) };
  });
