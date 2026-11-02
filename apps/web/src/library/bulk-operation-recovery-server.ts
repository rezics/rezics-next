import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import { prepareSession, sessionSubject, viewerCredential, requestCsrfToken } from '../session/request';
import type { SessionEnv } from '../session/client';
import { MediaProblem } from '../media/kernel';
import {
  operationAddress, readNativeOperation, cancelNativeOperation,
  type OperationAddress, type CancelCommand, type BulkRead, type CancelResult,
} from './bulk-operation-recovery-native';

/** A fresh request binds every call, including retries, to the captured sender. */
async function credential(viewer: string, csrf?: string) {
  const request = new Request(getRequest());
  const stale = await prepareSession(request, env as Partial<SessionEnv>);
  if (stale || request.headers.has('authorization') || sessionSubject(request) !== viewer) return null;
  if (csrf !== undefined && (!csrf || requestCsrfToken(request) !== csrf || request.headers.get('x-csrf-token') !== csrf))
    return null;
  return viewerCredential(request);
}

export const readBulkOperation = createServerFn({ method: 'GET' })
  .validator(operationAddress)
  .handler(async ({ data }: { data: OperationAddress }): Promise<BulkRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const authorization = await credential(data.viewer);
      return authorization ? readNativeOperation(kernelClient(), authorization, data) : { state: 'forbidden' };
    } catch (error) {
      return { state: error instanceof MediaProblem && error.problem.status === 403 ? 'forbidden' : 'unavailable' };
    }
  });

export const cancelBulkOperation = createServerFn({ method: 'POST' })
  .validator((input: CancelCommand): CancelCommand => {
    const address = operationAddress(input);
    if (typeof input.key !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.key) || typeof input.csrf !== 'string')
      throw new Error('Invalid cancellation');
    return { id: address.id, viewer: address.viewer, key: input.key, csrf: input.csrf };
  })
  .handler(async ({ data }): Promise<CancelResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const authorization = await credential(data.viewer, data.csrf);
      return authorization ? cancelNativeOperation(kernelClient(), authorization, data) : { state: 'forbidden' };
    } catch (error) {
      return { state: error instanceof MediaProblem && error.problem.status === 403 ? 'forbidden' : 'unavailable' };
    }
  });
