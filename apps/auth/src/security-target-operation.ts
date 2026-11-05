import type { SecurityActionResult } from './security-reconciliation';

// Two sequential five-second native calls (account check, exact command), plus
// two seconds for browser/BFF delivery. This bounds waiting, never native work.
export const SECURITY_ACTION_WAIT_MS = 12_000;

function acknowledgement(value: unknown): SecurityActionResult {
  if (!value || typeof value !== 'object' || !('kind' in value)) return { kind: 'unknown' };
  const result = value as SecurityActionResult;
  if (Object.keys(result).some((key) => key !== 'kind' && key !== 'sessionEnded')) return { kind: 'unknown' };
  if (!['accepted', 'unknown', 'signed-out', 'denied', 'step-up', 'last-credential', 'failure'].includes(result.kind))
    return { kind: 'unknown' };
  if ('sessionEnded' in result && typeof result.sessionEnded !== 'boolean') return { kind: 'unknown' };
  return result;
}

/** One invocation only. Abort or loss after invocation cannot prove non-dispatch. */
export async function waitForSecurityAction(
  dispatch: (signal: AbortSignal) => Promise<SecurityActionResult>,
  caller?: AbortSignal,
): Promise<SecurityActionResult> {
  if (caller?.aborted) return { kind: 'failure' };
  const controller = new AbortController();
  const cancel = () => controller.abort(caller?.reason);
  caller?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), SECURITY_ACTION_WAIT_MS);
  let onAbort = () => {};
  try {
    const abandoned = new Promise<SecurityActionResult>((resolve) => {
      onAbort = () => resolve({ kind: 'unknown' });
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    // Promise.resolve also captures a synchronous source exception. Never retry.
    return await Promise.race([
      abandoned,
      Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) return { kind: 'unknown' as const };
          return dispatch(controller.signal);
        })
        .then(acknowledgement, () => ({ kind: 'unknown' as const })),
    ]);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
