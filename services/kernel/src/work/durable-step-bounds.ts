/** Pinned DBOS 5.5.3 native step/checkpoint composition, shared by durable owners. */
import { declareBound, sumBounds } from '@rezics/bounds';
import { SELECTED_COST } from './selected-runtime-cost.ts';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const cost = (rows: number, points: number, statements: number, transferred: number) =>
  declareBound({
    candidateKeys: points,
    nativeRows: rows,
    identityMetadataRows: 0,
    nativePoints: points,
    witnessKeys: 0,
    emptySeeks: points,
    statements,
    bytes: transferred,
    engineRequests: 0,
  });
// Exact status/operation result lookup, cancellation and owner SHARE/NO KEY UPDATE;
// operation_outputs PK conflict/RETURNING, owner/FK and writer-domain triggers.
// Controls include BEGIN/COMMIT and failure ROLLBACK. No workflow-history range is read.
const lookup = cost(4, 4, 3, 8_192);
const checkpoint = cost(12, 12, 10, 32_768);
const workflowOutput = cost(16, 16, 12, 32_768);

export function durableStepPlan(input: unknown, outputBytes: number) {
  const serialization = cost(0, 0, 0, bytes(input) + 3 * outputBytes);
  const terms = Object.freeze({ lookup, checkpoint, serialization });
  return Object.freeze({ terms, total: sumBounds(...Object.values(terms)) });
}
export function durableSegmentPlan(input: unknown) {
  return sumBounds(workflowOutput, cost(0, 0, 0, 3 * bytes(input)));
}
export function durableEnqueuePlan(input: unknown, options: unknown) {
  const native = sumBounds(SELECTED_COST.enqueue, cost(0, 0, 0, bytes([input, options])));
  // The one actual WorkClient.enqueue is separate from its native SQL and buffers.
  return Object.freeze({ native, total: sumBounds(native, declareBound({ ...cost(0, 0, 0, 0), engineRequests: 1 })) });
}
