import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import type { ErasureIdentity } from './author-erasure';
import { MediaProblem } from '../media/kernel';

/** Reuse session/CSRF authority; a caller's bearer or authorId cannot reconstruct the acting account. */
export async function authorErasureIdentity(
  request: Request,
  env: Partial<SessionEnv>,
): Promise<{ kind: 'available'; identity: ErasureIdentity } | { kind: 'signed-out' | 'forbidden' | 'unavailable' }> {
  try {
    await prepareSession(request, env);
    const authorization = viewerCredential(request);
    const subject = sessionSubject(request);
    return authorization && subject
      ? { kind: 'available', identity: { authorization, subject } }
      : { kind: 'signed-out' };
  } catch (error) {
    return { kind: error instanceof MediaProblem && error.problem.status === 403 ? 'forbidden' : 'unavailable' };
  }
}
