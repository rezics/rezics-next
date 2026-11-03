import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import { cookie, SESSION_COOKIE } from '../session/cookies';
import type { SessionEnv } from '../session/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';
import { previewFilteredStatusNative, confirmFilteredStatusNative } from './bulk-filtered-status-native';
import type { FilteredStatusCall, FilteredStatusCaptureCall, FilteredStatusResult } from './bulk-filtered-status';

const domain = 'rezics.library-filtered-status.v1';
type Envelope = {
  binding: string;
  viewer: string;
  body: string;
  previewHeaders: Record<string, string>;
  confirmHeaders: Record<string, string>;
  operationId?: string;
};
const binding = (request: Request) =>
  JSON.stringify([new URL(request.url).origin, cookie(request, SESSION_COOKIE), sessionSubject(request)]);
async function key() {
  const secret = (env as Partial<SessionEnv>).WEBSITE_CLIENT_KEY;
  if (!secret) throw new Error('Missing web credential');
  return crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${domain}\n${secret}`)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}
async function seal(value: Envelope) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(JSON.stringify(value))),
  );
  return btoa(Array.from(new Uint8Array([...iv, ...encrypted]), (n) => String.fromCharCode(n)).join(''));
}
async function open(token: string): Promise<Envelope> {
  if (typeof token !== 'string' || token.length > 192 * 1024) throw new TypeError('Invalid filtered status command');
  const bytes = Uint8Array.from(atob(token), (c) => c.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12) },
    await key(),
    bytes.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as Envelope;
}
async function viewer(request: Request, csrf: string | undefined) {
  setResponseHeader('cache-control', 'private, no-store');
  if (await prepareSession(request, env as Partial<SessionEnv>)) throw new Error('Filtered status viewer unavailable');
  if (
    request.headers.has('authorization') ||
    !cookie(request, SESSION_COOKIE) ||
    !sessionSubject(request) ||
    !csrf ||
    request.headers.get('x-csrf-token') !== csrf ||
    requestCsrfToken(request) !== csrf
  )
    throw new Error('Filtered status viewer changed');
}

/** Seal both commands before the first native write. Recovery can never renew the credential. */
export const captureFilteredStatusCommand = createServerFn({ method: 'POST' })
  .validator((data: FilteredStatusCaptureCall) => data)
  .handler(async ({ data }): Promise<string> => {
    const request = getRequest();
    await viewer(request, data.headers['x-csrf-token']);
    const authorization = viewerCredential(request);
    if (!authorization || sessionSubject(request) !== data.viewer) throw new Error('Filtered status viewer changed');
    if (new TextEncoder().encode(data.body).byteLength > 64 * 1024)
      throw new RangeError('Filtered status request exceeds limit');
    const body = JSON.parse(data.body);
    if (
      body.action !== 'set_status' ||
      body.selection?.kind !== 'query' ||
      typeof body.selection.sourceId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(data.previewKey) ||
      !/^[0-9a-f-]{36}$/i.test(data.confirmKey)
    )
      throw new TypeError('Invalid filtered status request');
    const headers = { ...data.headers, authorization, 'content-type': 'application/json' };
    return seal({
      binding: binding(request),
      viewer: data.viewer,
      body: data.body,
      previewHeaders: { ...headers, 'idempotency-key': data.previewKey },
      confirmHeaders: { ...headers, 'idempotency-key': data.confirmKey },
    });
  });

async function command(call: FilteredStatusCall): Promise<Envelope> {
  const request = getRequest();
  await viewer(request, call.headers['x-csrf-token']);
  const original = await open(call.token);
  if (
    original.binding !== binding(request) ||
    original.viewer !== sessionSubject(request) ||
    original.previewHeaders['x-csrf-token'] !== call.headers['x-csrf-token']
  )
    throw new Error('Filtered status command retired');
  return original;
}
export const previewFilteredStatus = createServerFn({ method: 'POST' })
  .validator((data: FilteredStatusCall) => data)
  .handler(async ({ data }): Promise<FilteredStatusResult> => {
    const original = await command(data);
    if (original.operationId) throw new TypeError('Invalid filtered preview command');
    const result = await previewFilteredStatusNative(kernelClient(), original.body, original.previewHeaders);
    if (result.kind !== 'ready') return result;
    return { ...result, confirmation: await seal({ ...original, operationId: result.operation.id }) };
  });
export const confirmFilteredStatus = createServerFn({ method: 'POST' })
  .validator((data: FilteredStatusCall) => data)
  .handler(async ({ data }): Promise<FilteredStatusResult> => {
    const original = await command(data);
    if (!original.operationId) throw new TypeError('Missing filtered status manifest');
    return confirmFilteredStatusNative(kernelClient(), original.operationId, original.confirmHeaders);
  });
