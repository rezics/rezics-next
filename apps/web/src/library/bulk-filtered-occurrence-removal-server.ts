import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';
import { captureEntryRestoreCredential, originalEntryRestoreCredential } from './entry-restore-credential';
import type { RemovalCall, RemovalRequest, RemovalResult, RemovalSender } from './bulk-filtered-occurrence-removal';

type PreviewResponse = Awaited<ReturnType<KernelClient['libraryOperations']['post']>>;
type ConfirmResponse = Awaited<ReturnType<ReturnType<KernelClient['libraryOperations']>['$confirm']['post']>>;

/** Consume the installed generated receiving union, including the non-operation preparing response. */
export function receiveFilteredOccurrenceRemoval(result: PreviewResponse | ConfirmResponse): RemovalResult {
  if (!result.error && result.data) {
    if ('preparing' in result.data && result.data.preparing === true) return { state: 'preparing' };
    if ('operation' in result.data && (result.status === 200 || result.status === 201))
      return { state: 'ready', operation: result.data.operation };
  }
  if (result.status === 503) return { state: 'unavailable' };
  if (result.status >= 400 && result.status < 500) return { state: 'refused' };
  return { state: 'uncertain' };
}

async function currentRequest(input: { viewer: string; headers: Readonly<Record<string, string>> }) {
  setResponseHeader('cache-control', 'private, no-store');
  const request = new Request(getRequest());
  const csrf = input.headers['x-csrf-token'];
  if (
    !csrf ||
    request.method !== 'POST' ||
    (await prepareSession(request, env as Partial<SessionEnv>)) ||
    request.headers.has('authorization') ||
    sessionSubject(request) !== input.viewer ||
    !viewerCredential(request) ||
    requestCsrfToken(request) !== csrf ||
    request.headers.get('x-csrf-token') !== csrf
  )
    return null;
  return request;
}

// Seal only the credential using the existing private credential carrier. Body, sender, full headers and key
// are captured in the mounted manifest before dispatch; neither a receipt read nor a retry captures again.
const prepare = createServerFn({ method: 'POST', strict: false })
  .validator((input: { viewer: string; headers: Readonly<Record<string, string>> }) => input)
  .handler(async ({ data }): Promise<string | null> => {
    const request = await currentRequest(data);
    if (!request) return null;
    return (await captureEntryRestoreCredential(request, env as Partial<SessionEnv>)) ?? null;
  });

async function originalHeaders(call: RemovalCall) {
  const request = await currentRequest(call);
  if (!request || !call.credential) return null;
  const authorization = await originalEntryRestoreCredential(request, env as Partial<SessionEnv>, call.credential);
  return authorization ? { ...call.headers, authorization, 'idempotency-key': call.idempotencyKey } : null;
}

const preview = createServerFn({ method: 'POST', strict: false })
  .validator((call: RemovalCall) => call)
  .handler(async ({ data }): Promise<RemovalResult> => {
    const headers = await originalHeaders(data);
    if (!headers) return { state: 'refused' };
    const body: RemovalRequest = JSON.parse(data.body);
    const result = await kernelClient().libraryOperations.post(body, {
      headers,
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    return receiveFilteredOccurrenceRemoval(result);
  });
const confirm = createServerFn({ method: 'POST', strict: false })
  .validator((call: RemovalCall & Readonly<{ operationId: string }>) => call)
  .handler(async ({ data }): Promise<RemovalResult> => {
    const headers = await originalHeaders(data);
    if (!headers) return { state: 'refused' };
    const result = await kernelClient()
      .libraryOperations({ operationId: data.operationId })
      .$confirm.post(JSON.parse(data.body), { headers, fetch: { cache: 'no-store', redirect: 'manual' } });
    return receiveFilteredOccurrenceRemoval(result);
  });

export const filteredOccurrenceRemovalSender: RemovalSender = {
  prepare: (input) => prepare({ data: input, headers: new Headers(input.headers) }),
  preview: (call) => preview({ data: call, headers: new Headers(call.headers) }),
  confirm: (call) => confirm({ data: call, headers: new Headers(call.headers) }),
};
