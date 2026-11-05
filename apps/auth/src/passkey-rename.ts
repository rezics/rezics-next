import { securityJsonStringBytes, securityResponseLimits } from '@rezics/auth-contract';
import { AUTH_POST_TIMEOUT_MS } from './api';
import { readJsonBounded } from './private-auth-json';

export type PasskeyRenameCommand = Readonly<{ accountId: string; id: string; name: string }>;
export type PasskeyRenameResult =
  | { kind: 'acknowledged'; id: string; name: string }
  | { kind: 'refused' | 'step-up' | 'unknown' | 'not-dispatched' };

// Exact public id/name projection; native private credential fields are never received.
export const PASSKEY_RENAME_RESPONSE_BYTES =
  '{"id":,"name":}'.length +
  securityJsonStringBytes(securityResponseLimits.id) +
  securityJsonStringBytes(securityResponseLimits.passkeyName);

export function createPasskeyRename(accountId: string, id: string, name: string): PasskeyRenameCommand | null {
  const label = name.trim();
  if (!label || label.length > securityResponseLimits.passkeyName) return null;
  return Object.freeze({ accountId, id, name: label });
}

/** One exact submission, bounded through body completion. An interrupted send stays unknown. */
export async function renamePasskey(
  command: PasskeyRenameCommand,
  caller: AbortSignal,
  onDispatch: () => void,
): Promise<PasskeyRenameResult> {
  if (caller.aborted) return { kind: 'not-dispatched' };
  const controller = new AbortController();
  let dispatched = false;
  let stop!: (result: PasskeyRenameResult) => void;
  const stopped = new Promise<PasskeyRenameResult>((resolve) => {
    stop = resolve;
  });
  const interrupt = () => stop({ kind: dispatched ? 'unknown' : 'not-dispatched' });
  const abort = () => controller.abort(caller.reason);
  controller.signal.addEventListener('abort', interrupt, { once: true });
  caller.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), AUTH_POST_TIMEOUT_MS);
  const send = async (): Promise<PasskeyRenameResult> => {
    controller.signal.throwIfAborted();
    dispatched = true;
    onDispatch();
    const response = await fetch('/passkeys/rename', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ id: command.id, name: command.name, reviewed_account_id: command.accountId }),
    });
    const value = await readJsonBounded(response, PASSKEY_RENAME_RESPONSE_BYTES, controller.signal);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'unknown' };
    const body = value as Record<string, unknown>;
    if (response.status === 200) {
      if (Object.keys(body).sort().join(',') !== 'id,name' || body.id !== command.id || body.name !== command.name)
        return { kind: 'unknown' };
      return { kind: 'acknowledged', id: command.id, name: command.name };
    }
    if (Object.keys(body).sort().join(',') === 'effect_status,error' && body.effect_status === 'not_applied') {
      if (response.status === 401 && body.error === 'step_up_required') return { kind: 'step-up' };
      if ([400, 401, 403, 404, 409].includes(response.status) && body.error === 'credential_effect_denied')
        return { kind: 'refused' };
    }
    return { kind: 'unknown' };
  };
  try {
    return await Promise.race([
      send().catch((): PasskeyRenameResult => ({ kind: dispatched ? 'unknown' : 'not-dispatched' })),
      stopped,
    ]);
  } finally {
    clearTimeout(timer);
    caller.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', interrupt);
  }
}
