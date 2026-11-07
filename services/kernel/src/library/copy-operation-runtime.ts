/** One accounting frame is shared by copy roots and their native statement leaves. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { declareBound, type Bound } from '@rezics/bounds';
import { currentCommandWorkAssociation } from '../command/work-context.ts';
import type { CopyOperationPlan, WorkDimensions } from './contract/index.ts';

const activeCopyOperation = new AsyncLocalStorage<CopyOperationPlan>();

/** The existing native receipt is eight axes; Copy proves the ninth axis is zero. */
export function copyWorkDimensions(bound: Bound): WorkDimensions {
  const complete = declareBound(bound);
  return Object.freeze({
    candidateKeys: complete.candidateKeys,
    nativeRows: complete.nativeRows,
    identityMetadataRows: complete.identityMetadataRows,
    emptySeeks: complete.emptySeeks,
    nativePoints: complete.nativePoints,
    witnessKeys: complete.witnessKeys,
    statements: complete.statements,
    bytes: complete.bytes,
  });
}

/** Consume a complete command attempt before its existing preparation and transaction. */
export function consumeCopyCommandAttempt(plan: CopyOperationPlan): Promise<void> {
  const association = currentCommandWorkAssociation();
  if (!association) return Promise.resolve();
  return association.run(
    `library.copy.${plan.kind}.${plan.branch}`,
    copyWorkDimensions(plan.total),
    async () => undefined,
  );
}

/** Bind nested SQL to the already consumed operation so its leaves do not double charge. */
export function bindCopyCommandOperation<T>(plan: CopyOperationPlan, dispatch: () => Promise<T>): Promise<T> {
  return activeCopyOperation.run(plan, dispatch);
}

/** Read-only roots reserve their complete two-observation operation once. */
export async function executeCopyOperation<T>(plan: CopyOperationPlan, dispatch: () => Promise<T>): Promise<T> {
  if (activeCopyOperation.getStore()) return dispatch();
  const association = currentCommandWorkAssociation();
  const reservation = association?.reserve(`library.copy.${plan.kind}.${plan.branch}`, copyWorkDimensions(plan.total));
  const settle = () => reservation?.settle();
  try {
    const result = await activeCopyOperation.run(plan, dispatch);
    settle();
    return result;
  } catch (error) {
    settle();
    throw error;
  }
}

export function executeCopyStatement<T>(kind: string, bound: Bound, dispatch: () => Promise<T>): Promise<T> {
  if (activeCopyOperation.getStore()) return dispatch();
  const association = currentCommandWorkAssociation();
  return association ? association.run(`library.copy.${kind}`, copyWorkDimensions(bound), dispatch) : dispatch();
}

export function executeCopyStatementWork<T>(kind: string, bound: Bound, dispatch: () => Promise<T>): Promise<T> {
  return executeCopyStatement(kind, bound, dispatch);
}
