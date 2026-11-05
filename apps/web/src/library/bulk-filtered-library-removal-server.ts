import * as v from 'valibot';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { acceptLanguage, kernelClient } from '../kernel/client';
import { cookie, SESSION_COOKIE } from '../session/cookies';
import type { SessionEnv } from '../session/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';
import { readBulkOperation } from './bulk-operation-recovery-server';
import { receiveUndoEvidence } from './bulk-operation-undo-evidence';
import type {
  FilteredRemovalCall,
  FilteredRemovalRequest,
  FilteredRemovalPreview,
  FilteredRemovalConfirmation,
  FilteredRemovalTransport,
} from './bulk-filtered-library-removal';

const domain = 'rezics.library-filtered-entry-remove.v1';
const bound = 96 * 1024;
const id = v.pipe(v.string(), v.uuid());
const captureInput = v.strictObject({
  viewer: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  locale: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
  headers: v.record(v.string(), v.string()),
  request: v.strictObject({
    action: v.literal('remove_from_library'),
    selection: v.strictObject({
      kind: v.literal('query'),
      sourceId: id,
      filter: v.optional(v.pipe(v.string(), v.maxLength(64 * 1024))),
      sort: v.optional(v.literal('id')),
    }),
  }),
});
const commandInput = v.object({
  capture: v.pipe(v.string(), v.minLength(1), v.maxLength(bound)),
  headers: v.record(v.string(), v.string()),
});
type Command = {
  viewer: string;
  locale: string;
  csrf: string;
  request: FilteredRemovalRequest;
  headers: { authorization: string; 'idempotency-key': string; 'accept-language': string; 'content-type': string };
  confirmationKey: string;
  operationId?: string;
};
const buffer = (bytes: Uint8Array): ArrayBuffer => Uint8Array.from(bytes).buffer;
const context = (settings: Partial<SessionEnv>) =>
  new TextEncoder().encode(
    JSON.stringify([domain, settings.AUTH_ISSUER, settings.API_RESOURCE, settings.WEBSITE_CLIENT_ID]),
  );
const binding = (request: Request) =>
  JSON.stringify([new URL(request.url).origin, cookie(request, SESSION_COOKIE) ?? null, sessionSubject(request)]);
async function key(settings: Partial<SessionEnv>) {
  if (!settings.WEBSITE_CLIENT_KEY) throw new Error('Missing web credential key');
  return crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${domain}\n${settings.WEBSITE_CLIENT_KEY}`)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}
async function seal(request: Request, command: Command) {
  const settings = env as Partial<SessionEnv>;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: buffer(iv), additionalData: context(settings) },
      await key(settings),
      new TextEncoder().encode(JSON.stringify({ binding: binding(request), command })),
    ),
  );
  const encoded = btoa(Array.from(new Uint8Array([...iv, ...bytes]), (byte) => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  if (encoded.length > bound) throw new RangeError('Filtered removal capture exceeds bound');
  return encoded;
}
async function session() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  if (await prepareSession(request, env as Partial<SessionEnv>)) throw new Error('Sign in again');
  if (!sessionSubject(request) || !viewerCredential(request)) throw new Error('Sign in again');
  return request;
}
async function open(call: FilteredRemovalCall) {
  const request = await session();
  const settings = env as Partial<SessionEnv>;
  const bytes = Uint8Array.from(atob(call.capture.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const decoded = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buffer(bytes.slice(0, 12)), additionalData: context(settings) },
    await key(settings),
    buffer(bytes.slice(12)),
  );
  const envelope = JSON.parse(new TextDecoder().decode(decoded)) as { binding: string; command: Command };
  const command = envelope.command;
  if (
    envelope.binding !== binding(request) ||
    command.viewer !== sessionSubject(request) ||
    !command.csrf ||
    command.csrf !== requestCsrfToken(request) ||
    command.csrf !== request.headers.get('x-csrf-token') ||
    command.csrf !== call.headers['x-csrf-token']
  )
    throw new Error('Filtered removal command belongs to another session');
  return { command, request };
}

/** Seal the complete native requests before the first write; subsequent session refreshes cannot replace them. */
const capture = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => v.parse(captureInput, input))
  .handler(async ({ data }) => {
    const request = await session();
    const csrf = requestCsrfToken(request);
    if (
      sessionSubject(request) !== data.viewer ||
      !csrf ||
      request.headers.get('x-csrf-token') !== csrf ||
      data.headers['x-csrf-token'] !== csrf
    )
      throw new Error('Filtered removal viewer changed');
    if (new TextEncoder().encode(JSON.stringify(data.request)).byteLength > 64 * 1024)
      throw new RangeError('Bulk command exceeds 64 KiB');
    return seal(request, {
      viewer: data.viewer,
      locale: data.locale,
      csrf,
      request: {
        action: 'remove_from_library',
        selection: {
          kind: 'query',
          sourceId: data.request.selection.sourceId,
          ...(data.request.selection.filter === undefined ? {} : { filter: data.request.selection.filter }),
          ...(data.request.selection.sort === undefined ? {} : { sort: data.request.selection.sort }),
        },
      },
      confirmationKey: crypto.randomUUID(),
      headers: {
        authorization: viewerCredential(request)!,
        'idempotency-key': crypto.randomUUID(),
        'accept-language': acceptLanguage(data.locale),
        'content-type': 'application/json',
      },
    });
  });

const preview = createServerFn({ method: 'POST', strict: false })
  .validator((input: unknown) => v.parse(commandInput, input))
  .handler(async ({ data }): Promise<FilteredRemovalPreview> => {
    const { command, request } = await open(data);
    if (command.operationId) return { state: 'refused' };
    try {
      const result = await kernelClient(command.locale).libraryOperations.post(command.request, {
        headers: command.headers,
        fetch: { cache: 'no-store', redirect: 'manual' },
      });
      if (result.status === 202 && result.data && 'preparing' in result.data) return { state: 'preparing' };
      if (result.status === 503) return { state: 'unavailable' };
      if (result.status === 422) return { state: 'unsupported' };
      if (result.error || !result.data || !('operation' in result.data))
        return { state: result.status === 0 || result.status >= 500 ? 'uncertain' : 'refused' };
      const operation = result.data.operation;
      const confirmation = await seal(request, {
        ...command,
        operationId: operation.id,
        headers: { ...command.headers, 'idempotency-key': command.confirmationKey },
      });
      return { state: 'ready', operation, confirmation };
    } catch {
      return { state: 'uncertain' };
    }
  });

const confirm = createServerFn({ method: 'POST', strict: false })
  .validator((input: unknown) => v.parse(commandInput, input))
  .handler(async ({ data }): Promise<FilteredRemovalConfirmation> => {
    const { command } = await open(data);
    if (!command.operationId) return { state: 'refused' };
    try {
      const result = await kernelClient(command.locale)
        .libraryOperations({ operationId: command.operationId })
        .$confirm.post({}, { headers: command.headers, fetch: { cache: 'no-store', redirect: 'manual' } });
      if (result.error || !result.data) return { state: 'uncertain' };
      return { state: 'ready', operation: result.data.operation };
    } catch {
      return { state: 'uncertain' };
    }
  });

export const filteredRemovalTransport: FilteredRemovalTransport = {
  capture: (data) => capture({ data, headers: new Headers(data.headers) }),
  preview: (data) => preview({ data, headers: new Headers(data.headers) }),
  confirm: (data) => confirm({ data, headers: new Headers(data.headers) }),
  read: async (data) => receiveUndoEvidence(await readBulkOperation({ data })),
};
