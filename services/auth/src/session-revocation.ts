import type { AccountWorkflowPorts, WorkflowFence } from '@rezics/auth-contract';
import type { AuthService } from './index.ts';

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

/** Mechanical continuation consumption only. The native Access port resolves
 * the original committed floor after authorizing its exact allowlisted step.
 * Neither a fresh approval nor the target's current floor may replace it. */
export async function revokeContinuationSessions(
  access: Pick<AccountWorkflowPorts<never>, 'authorizeSessionRevocation' | 'readContinuation' | 'authorizeContinuation'>,
  auth: Pick<AuthService['internal'], 'revokeSessions'>,
  input: { accountId: string; operationKey: string },
  requireOriginal = false,
): Promise<void> {
  const { accountId, operationKey } = structuredClone(input);
  const deadline = Date.now() + 10_000;
  if (access.authorizeSessionRevocation) {
    const original = await access.authorizeSessionRevocation({ accountId, operationKey }, { deadline });
    if (original.accountId !== accountId || original.operationKey !== operationKey)
      throw new Error('Native session revocation binding conflict');
    return auth.revokeSessions(accountId, { original, deadline });
  }
  // Historical callback-only hosts retain deletion without manufacturing an
  // original-bound result. The trusted original-suspension entry requires it.
  if (requireOriginal) throw new Error('Native session revocation binding unavailable');
  const root = await access.readContinuation?.(operationKey, accountId);
  const entry = root?.allowlist.find((item) => item.step === REVOKE_SESSIONS_STEP && item.target === accountId);
  if (!root || root.operationKey !== operationKey || !entry || !access.authorizeContinuation)
    throw new Error('Native session revocation continuation unavailable');
  await access.authorizeContinuation(root.reference, entry);
  return auth.revokeSessions(accountId);
}

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
