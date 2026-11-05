import { createServerOnlyFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';

export function expectedCandidateReader(input: unknown): string {
  if (
    !input ||
    typeof input !== 'object' ||
    !('expectedReader' in input) ||
    typeof input.expectedReader !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/i.test(input.expectedReader)
  )
    throw new Error('Invalid candidate reader');
  return input.expectedReader;
}

/** Expected reader is only a mismatch guard, never a credential or an authentication stamp. */
export const candidateAuthorization = createServerOnlyFn(
  async (expectedReader: string | undefined): Promise<string | null> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const reader = sessionSubject(request);
    const authorization = viewerCredential(request);
    return reader && reader === expectedReader ? authorization : null;
  },
);
