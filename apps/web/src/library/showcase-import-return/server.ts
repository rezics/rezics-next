import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { validExpectedReader, type ExpectedReader } from '../../session/expected-reader';
import { loadImportLibrary } from './read';

export const readImportLibrary = createServerFn({ method: 'GET' })
  .validator((input: unknown): ExpectedReader => {
    if (!validExpectedReader(input)) throw new Error('Invalid Library return');
    return { expectedReader: input.expectedReader, expectedCredential: input.expectedCredential };
  })
  .handler(({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadImportLibrary(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
