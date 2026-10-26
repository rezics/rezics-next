import type { WorkflowFence } from '@rezics/auth-contract';

/** Live server capability carried by a resolved session revocation approval. It runs the native Access command
 * that commits the epoch fence, its receipt and the continuation, and is never persisted as workflow input. */
export type SessionRevocationContext = {
  revokeSessions(): Promise<WorkflowFence & { continuationOperationKey?: string }>;
};

export function sessionRevocation(context: unknown): SessionRevocationContext['revokeSessions'] | undefined {
  const capability = (context as Partial<SessionRevocationContext> | null | undefined)?.revokeSessions;
  return typeof capability === 'function' ? capability.bind(context) : undefined;
}

/** The step that asks Auth to delete the person's sessions, after Access committed the fence. */
export const REVOKE_SESSIONS_STEP = 'revoke-auth-sessions';
export const stepFailureMessage = (name: string) => `Account workflow step failed: ${name}`;

/** Access committed the fence and its receipt, so every earlier session and token is already refused, but Auth
 * did not delete the sessions. The fence stays; the same operation resumes the deletion. */
export class RevocationFailedError extends Error {
  readonly code = 'revocation-failed';

  constructor() {
    super('revocation-failed');
    this.name = 'RevocationFailedError';
  }
}

/** Failures of Auth's own deletion step answer `revocation-failed`; refusals before the fence and every other
 * failure keep their identity. */
export async function answerRevocation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Error && error.message === stepFailureMessage(REVOKE_SESSIONS_STEP))
      throw new RevocationFailedError();
    throw error;
  }
}
