import { searchSessionOwner } from './search-session-owner';
import type { SessionEnv } from '../session/client';

export type ScopedSearchReader = Readonly<{
  owner: string;
  principal: string;
  authorization: string;
}>;

/** Prepare the current cookie-backed reader once; callers use its credential and subject together. */
export async function readScopedSearchReader(request: Request): Promise<ScopedSearchReader | undefined> {
  const [{ env }, session] = await Promise.all([import('cloudflare:workers'), import('../session/request')]);
  const { setResponseHeader } = await import('@tanstack/react-start/server');
  setResponseHeader('Cache-Control', 'private, no-store');
  await session.prepareSession(request, env as Partial<SessionEnv>);
  const principal = session.sessionSubject(request);
  const authorization = session.viewerCredential(request);
  if (!principal || !authorization) return undefined;
  const owner = searchSessionOwner({ state: 'signed-in', subject: principal });
  return owner ? { owner, principal, authorization } : undefined;
}
