import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential, requestCsrfToken } from '../session/request';
import { captureEntryRestoreCredential } from './entry-restore-credential';
import { operationAddress, readNativeOperation } from './bulk-operation-recovery-native';
import { receiveUndoEvidence } from './bulk-operation-undo-evidence';
import { undoOperand, type UndoTarget, type UndoPreparation } from './bulk-operation-undo';

export function undoTarget(input: UndoTarget): UndoTarget {
  const address = operationAddress(input);
  if (
    !/^(0|[1-9][0-9]{0,3})$/.test(input.ordinal) ||
    typeof input.subjectId !== 'string' ||
    !input.subjectId ||
    input.subjectId.length > 128 ||
    typeof input.csrf !== 'string' ||
    !input.csrf
  )
    throw new Error('Invalid Undo target');
  return { ...address, ordinal: input.ordinal, subjectId: input.subjectId, csrf: input.csrf };
}

/** Deliberate POST preparation only: reauthorize, reread one bounded page and seal the original credential. */
export async function prepareNativeBulkUndo(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: UndoTarget,
): Promise<UndoPreparation> {
  try {
    input = undoTarget(input);
    if (
      request.method !== 'POST' ||
      (await prepareSession(request, env)) ||
      request.headers.has('authorization') ||
      sessionSubject(request) !== input.viewer ||
      requestCsrfToken(request) !== input.csrf ||
      request.headers.get('x-csrf-token') !== input.csrf
    )
      return { state: 'forbidden' };
    const authorization = viewerCredential(request);
    if (!authorization) return { state: 'forbidden' };
    const exposure = await client.platform.exposure.get({
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (exposure.error || !exposure.data?.admitted.some((operation) => String(operation) === 'library_entry.restore'))
      return { state: 'forbidden' };
    const result = receiveUndoEvidence(await readNativeOperation(client, authorization, input));
    if (result.state !== 'ready') return result;
    const row = result.page.outcomes.find(
      (outcome) => outcome.ordinal === input.ordinal && outcome.subjectId === input.subjectId,
    );
    if (
      !row ||
      result.operation.action !== 'remove_from_library' ||
      row.state !== 'applied' ||
      !row.deletion ||
      row.memberId
    )
      return { state: 'invalid' };
    const operand = undoOperand(result.operation, row);
    if (!operand) return { state: 'expired' };
    const credential = await captureEntryRestoreCredential(request, env);
    if (!credential) return { state: 'forbidden' };
    return { state: 'ready', undo: { ...operand, idempotencyKey: crypto.randomUUID(), credential } };
  } catch {
    return { state: 'unavailable' };
  }
}
