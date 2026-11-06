import type { KernelClient } from '@rezics/client';
import { isRecord } from './shared';

// Eden retains all successful bodies in data; callers select this type only after status 200.
export type NativePageBody = Extract<
  NonNullable<Awaited<ReturnType<KernelClient['pages']['$read']['post']>>['data']>,
  { reads: unknown }
>;

/** Route identity does not supply subject action advice. Preserve only the native subject envelope. */
export function cataloguePageBody(native: NativePageBody) {
  const { account: _account, viewer, actions, ...page } = native;
  return {
    ...page,
    subject: page.subject ?? null,
    ...(viewer && 'state' in viewer ? { viewer } : {}),
    ...(actions && 'status' in actions ? { actions } : {}),
  };
}

export class PageReadError extends Error {
  readonly name = 'PageReadError';
  readonly statusCode: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly headers: Record<string, string>;
  readonly problem: { status: number; code: string; retryable: boolean };

  constructor(
    code: string,
    readonly status: number,
    readonly retryAfter?: string,
  ) {
    super(code);
    this.code = code;
    this.statusCode = status;
    this.retryable = status === 202 || status === 409 || status === 429 || status >= 500;
    this.headers = { 'cache-control': 'private, no-store', ...(retryAfter ? { 'retry-after': retryAfter } : {}) };
    this.problem = { status, code, retryable: this.retryable };
  }
}

function retryAfterHeader(headers: unknown): string | undefined {
  if (headers == null) return;
  try {
    const value = new Headers(headers as HeadersInit).get('retry-after');
    return value?.trim() ? value : undefined;
  } catch {
    return;
  }
}

export function pageReadError(value: unknown, status: number, headers?: unknown): PageReadError {
  const code = isRecord(value) && typeof value.code === 'string' && value.code ? value.code : 'internal_error';
  const retryAfter = retryAfterHeader(headers);
  return retryAfter ? new PageReadError(code, status, retryAfter) : new PageReadError(code, status);
}

/** Expected native failures cross server functions as data, preserving status and delay in production. */
export type PageReadFailure = {
  kind: 'read-failed';
  failure: { code: string; status: number; retryAfter?: string };
};

export async function capturePageRead<T>(read: () => Promise<T>): Promise<T | PageReadFailure> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof PageReadError)) throw error;
    return {
      kind: 'read-failed',
      failure: {
        code: error.code,
        status: error.status,
        ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
      },
    };
  }
}

/** Recreate the typed route error after transport, where the router can retain its native HTTP semantics. */
export function admitPageRead<T extends { kind: string }>(result: T | PageReadFailure): T {
  if (result.kind === 'read-failed' && 'failure' in result) {
    const { code, status, retryAfter } = (result as PageReadFailure).failure;
    throw new PageReadError(code, status, retryAfter);
  }
  return result as T;
}
