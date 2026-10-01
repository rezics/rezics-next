/** Business operations report owner confirmation, never infer success from dispatch. */
export type EffectState = 'confirmed' | 'pending' | 'uncertain' | 'failed';
export interface OperationItem {
  ordinal: number;
  target: string;
  state: EffectState;
  receipt: string | null;
  continuation: string | null;
  error: string | null;
}
export interface OperationOutcome {
  operationId: string;
  status: 'accepted' | 'completed' | 'partial' | 'cancelled';
  items: OperationItem[];
  continuation: string | null;
}

/** Shared conformance assertion for decision, import and wiki intake owners. */
export function assertOperationOutcome(outcome: OperationOutcome): void {
  if (
    !outcome.operationId ||
    new Set(outcome.items.map((item) => item.ordinal)).size !== outcome.items.length ||
    outcome.items.some(
      (item) =>
        !Number.isInteger(item.ordinal) ||
        item.ordinal < 1 ||
        (item.state === 'confirmed' && (!item.receipt || item.continuation !== null)),
    )
  ) {
    throw new Error('Invalid operation effect confirmation');
  }
  if (
    outcome.status === 'completed' &&
    (outcome.items.some((item) => item.state !== 'confirmed') || outcome.continuation !== null)
  )
    throw new Error('Completed operation needs every receipt');
  if (outcome.status === 'cancelled' && outcome.continuation !== null) {
    throw new Error('Cancellation stops future effects; reversal requires a new operation');
  }
  if (outcome.status === 'accepted' && outcome.items.some((item) => item.state !== 'pending')) {
    throw new Error('Accepted operation has not dispatched effects');
  }
}

/** Cancellation retains confirmed effects. It cannot describe them as undone. */
export function assertOperationTransition(
  previous: OperationOutcome,
  next: OperationOutcome,
): void {
  assertOperationOutcome(previous);
  assertOperationOutcome(next);
  if (
    previous.operationId !== next.operationId ||
    previous.items.length !== next.items.length ||
    previous.items.some((item) => {
      const current = next.items.find((candidate) => candidate.ordinal === item.ordinal);
      return (
        !current ||
        current.target !== item.target ||
        (item.state === 'confirmed' &&
          (current.state !== 'confirmed' || current.receipt !== item.receipt))
      );
    }) ||
    (previous.status === 'cancelled' && next.status !== 'cancelled') ||
    (previous.status === 'completed' && next.status !== 'completed')
  ) {
    throw new Error('Operation cannot undo confirmation or resume cancellation');
  }
}

export function operationOutcome(
  operationId: string,
  items: OperationItem[],
  cancelled = false,
): OperationOutcome {
  const status = cancelled
    ? 'cancelled'
    : items.every((item) => item.state === 'confirmed')
      ? 'completed'
      : items.every(
            (item) => item.state === 'pending' && item.error === null && item.continuation === null,
          )
        ? 'accepted'
        : 'partial';
  const result: OperationOutcome = {
    operationId,
    status,
    items,
    continuation: status === 'completed' || cancelled ? null : operationId,
  };
  assertOperationOutcome(result);
  return result;
}
