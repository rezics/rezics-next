import { createServerOnlyFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { expectedCandidateReader } from '../features/pages/visit-host-port';

export { expectedCandidateReader };

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
