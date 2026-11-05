import type { SessionEnv } from '../../session/client';
import { carriesSession } from '../../session/csrf';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';

export async function boundViewer(request: Request, env: Partial<SessionEnv>, viewerId: string) {
  // A supplied bearer cannot replace the cookie BFF's server-held viewer.
  if (request.headers.has('authorization') || !carriesSession(request)) return null;
  await prepareSession(request, env);
  const authorization = viewerCredential(request);
  return authorization && sessionSubject(request) === viewerId ? authorization : null;
}
