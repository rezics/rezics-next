import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { UUID } from './price';
import type { SessionEnv } from '../session/client';

export type ReconciliationIntent = Readonly<{ orderId: string; idempotencyKey: string }>;
export type ReconciliationResult =
  | { kind: 'queued'; orderId: string; reconciliation: 'queued' }
  | { kind: 'denied' | 'unavailable' | 'retry' | 'conflict' };
export type ReconciliationPhase = 'ready' | 'refreshing' | ReconciliationResult['kind'];
export type ReconciliationSender = (intent: ReconciliationIntent) => Promise<ReconciliationResult>;

/** One explicit operation retains its distinct key through lost responses and retries. */
export function createReconciliationRequest(
  orderId: string,
  send: ReconciliationSender,
  newKey: () => string = () => crypto.randomUUID(),
) {
  let intent: ReconciliationIntent | undefined;
  let pending = false;
  let queued: ReconciliationResult | undefined;
  return async (): Promise<ReconciliationResult | undefined> => {
    if (pending) return;
    if (queued) return queued;
    intent ??= Object.freeze({ orderId, idempotencyKey: newKey() });
    pending = true;
    try {
      const result = await send(intent);
      if (result.kind === 'queued') {
        if (result.orderId !== orderId || result.reconciliation !== 'queued') return { kind: 'unavailable' };
        queued = result;
      }
      return result;
    } catch {
      return { kind: 'retry' };
    } finally {
      pending = false;
    }
  };
}

function validateIntent(input: unknown): ReconciliationIntent {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== 'orderId' && key !== 'idempotencyKey') ||
    !('orderId' in input) ||
    typeof input.orderId !== 'string' ||
    !UUID.test(input.orderId) ||
    !('idempotencyKey' in input) ||
    typeof input.idempotencyKey !== 'string' ||
    !UUID.test(input.idempotencyKey)
  )
    throw new Error('Invalid order reconciliation intent');
  return { orderId: input.orderId, idempotencyKey: input.idempotencyKey };
}

/** Exact pending generated-client binding. No raw HTTP fallback or cast Treaty route. */
export const nativeOrderReconcile: (
  client: KernelClient,
  authorization: string,
  intent: ReconciliationIntent,
) => Promise<ReconciliationResult> = async () => ({ kind: 'unavailable' });

export const requestOrderReconciliation = createServerFn({ method: 'POST' })
  .validator(validateIntent)
  .handler(async ({ data }): Promise<ReconciliationResult> => {
    const [{ getRequest, setResponseHeader }, { env }, { prepareSession, viewerCredential }, { kernelClient }] =
      await Promise.all([
        import('@tanstack/react-start/server'),
        import('cloudflare:workers'),
        import('../session/request'),
        import('../kernel/client'),
      ]);
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    // The current session and ordinary POST middleware enforce Origin and CSRF.
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) return { kind: 'denied' };
    return nativeOrderReconcile(kernelClient(), authorization, data);
  });
