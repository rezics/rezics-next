import {
  OPERATOR_TRANSFER_PAGE_MAX_RESPONSE_BYTES,
  OPERATOR_TRANSFER_PAGE_MAX_ERROR_BYTES,
} from '@rezics/auth-contract';
import type { AuthPostResult } from './api';
import { privateAuthRead } from './private-auth-read';
import { readJsonBounded } from './private-auth-json';

export type OperatorTransferPageInput =
  | { kind: 'readiness' }
  | { kind: 'source'; subjectAccountId: string }
  | {
      kind: 'destination';
      request: {
        version: 1;
        previous: { operatorAccountId: string; subjectAccountId: string; reservationId: string };
        expectedVersion: string;
        operatorAccountId: string;
        sourceOperationKey: string;
      };
    };
export type OperatorTransferPageResponse = {
  viewer:
    | { kind: 'ready' }
    | { kind: 'authentication-required'; continuation: 'operator-transfer' }
    | { kind: 'signed-out' }
    | { kind: 'refused' };
  review:
    | { kind: 'readiness' }
    | {
        kind: 'source';
        relation: {
          previous: { operatorAccountId: string; subjectAccountId: string; reservationId: string };
          expectedVersion: string;
        };
        action: 'allowed';
      }
    | { kind: 'destination'; destinationAccountId: string; action: 'allowed' | 'denied' }
    | { kind: 'missing' | 'refused' | 'changed' | 'unavailable' };
};

export const OPERATOR_TRANSFER_PAGE_PATH = '/account-management/operators/transfer-review';
/** This read-only POST never shares mutation transport or retries a command. */
export async function requestOperatorTransferPage(
  input: OperatorTransferPageInput,
  signal?: AbortSignal,
): Promise<AuthPostResult> {
  try {
    return await privateAuthRead(async (readSignal): Promise<AuthPostResult> => {
      const response = await fetch(OPERATOR_TRANSFER_PAGE_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: readSignal,
      });
      let body: unknown;
      try {
        body = await readJsonBounded(
          response,
          response.status === 200 ? OPERATOR_TRANSFER_PAGE_MAX_RESPONSE_BYTES : OPERATOR_TRANSFER_PAGE_MAX_ERROR_BYTES,
          readSignal,
        );
      } catch (error) {
        readSignal.throwIfAborted();
        // authPost historically retained HTTP classification for unreadable
        // error bodies. Successful malformed advice is simply unavailable.
        if (response.status === 200) throw error;
      }
      if (response.status === 200) return { ok: true, body };
      const error = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
      const code = typeof error?.code === 'string' ? error.code : typeof error?.error === 'string' ? error.error : '';
      const retryAfter = response.headers.get('Retry-After');
      return {
        ok: false,
        status: response.status,
        code,
        retryAfter: retryAfter && /^\d+$/.test(retryAfter) ? retryAfter : null,
        ...(error?.effect_status === 'not_applied' ? { effectStatus: 'not_applied' as const } : {}),
      };
    }, signal);
  } catch (error) {
    return {
      ok: false,
      status: 503,
      code: error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'unavailable',
      retryAfter: null,
    };
  }
}
