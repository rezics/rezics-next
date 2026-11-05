import {
  readOperatorRelation,
  refreshTransferAdvice,
  type OperatorRelation,
  type TransferAttempt,
  type TransferFailure,
  type TransferResult,
} from './operator-transfer';

export type TransferRecoveryKind =
  | 'none'
  | 'saved-step'
  | 'source-unknown'
  | 'source-acknowledged'
  | 'source-acknowledged-conflict'
  | 'destination-accepted'
  | 'unreadable';

export type TransferRecoveryRead =
  | { kind: 'relation'; relation: OperatorRelation }
  | { kind: 'advice' }
  | TransferFailure;

export function transferRecoveryKind(
  attempt: TransferAttempt | null,
  result: TransferResult | null = null,
): TransferRecoveryKind {
  if (result?.kind === 'acknowledged' && result.readback.kind === 'failure' && result.readback.reason === 'conflict')
    return 'source-acknowledged-conflict';
  if ((attempt?.side === 'source' && attempt.phase === 'readback') || result?.kind === 'acknowledged')
    return 'source-acknowledged';
  if (attempt?.side === 'source' && attempt.phase === 'execute') return 'source-unknown';
  if (attempt?.side === 'destination' && attempt.phase === 'accepted') return 'destination-accepted';
  return attempt ? 'saved-step' : 'none';
}

export function retainsTransferWork(kind: TransferRecoveryKind): boolean {
  return kind !== 'none';
}

export function confirmsTransferReadback(attempt: TransferAttempt, relation: OperatorRelation): boolean {
  return (
    attempt.side === 'source' &&
    attempt.phase === 'readback' &&
    relation.previous.operatorAccountId === attempt.request.operatorAccountId &&
    BigInt(relation.expectedVersion) > BigInt(attempt.request.expectedVersion) &&
    relation.previous.reservationId !== attempt.request.previous.reservationId
  );
}

/** Recovery is deliberately read-only. It never submits approval or execution. */
export async function readTransferRecovery(attempt: TransferAttempt): Promise<TransferRecoveryRead> {
  if (attempt.side === 'source' && (attempt.phase === 'execute' || attempt.phase === 'readback')) {
    const relation = await readOperatorRelation(attempt.request.previous.subjectAccountId, attempt.accountId);
    return relation.kind === 'ready' ? { kind: 'relation', relation: relation.relation } : relation;
  }
  const failure = await refreshTransferAdvice(attempt);
  return failure ?? { kind: 'advice' };
}
