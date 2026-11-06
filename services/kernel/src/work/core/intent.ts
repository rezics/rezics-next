import type { WorkIntent, WorkScopedRequest } from '../contract/index.ts';
import { isWorkQueueName } from './queues.ts';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const OWNER = /^[a-z][a-z0-9_.-]{0,95}$/;

export function assertWorkIntent(intent: WorkIntent): void {
  if (!isWorkQueueName(intent.queue) || !intent.workflowName || !intent.workflowId)
    throw new TypeError('An operational intent requires an existing queue, workflow name and deterministic id');
}

export function assertScopedWorkIdentity(request: WorkScopedRequest, custodyId = request.intent.workflowId): void {
  if (!UUID.test(custodyId) || !OWNER.test(request.owner)) throw new TypeError('Invalid scoped work identity');
}

export function assertSelectedNativeDeclarations(native: readonly Readonly<{ sql: string; limit: number }>[]): void {
  if (
    native.length > 64 ||
    new Set(native.map((item) => item.sql)).size !== native.length ||
    native.some((item) => !item.sql || !Number.isSafeInteger(item.limit) || item.limit < 1 || item.limit > 64)
  )
    throw new TypeError('Invalid selected native declaration');
}
