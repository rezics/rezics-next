/** Context the supported Codex continuation-renewal handler requires before it acts. */
type ContinuationRenewalContext = {
  engine?: unknown;
  supermanager?: unknown;
  continuationAsked?: unknown;
  continuationRenewed?: unknown;
  pendingRenewal?: unknown;
};

/**
 * True only for the pending Codex handshake to the configured supermanager. Ordinary messages that contain the
 * handshake words are not a renewal, regardless of recipient or letter case.
 */
export function isPendingContinuationHandshake(summary: string, recipient: string, state: unknown): boolean {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  const context = state as ContinuationRenewalContext;
  return (
    context.engine === 'codex' &&
    Boolean(context.continuationAsked) &&
    !context.continuationRenewed &&
    !context.pendingRenewal &&
    typeof context.supermanager === 'string' &&
    recipient === context.supermanager &&
    /continuation written/i.test(summary)
  );
}
