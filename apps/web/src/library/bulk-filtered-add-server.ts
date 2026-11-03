import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { acceptLanguage, kernelClient, requestLocale } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';
import { captureEntryRestoreCredential, originalEntryRestoreCredential } from './entry-restore-credential';
import { loadCollectionDestination } from './collection-read';
import { captureFilteredAdd, type FilteredAddCapture, type FilteredAddPort } from './bulk-filtered-add';
import { sendFilteredAdd, type FilteredAddCommand, type FilteredAddResult } from './bulk-filtered-add-native';
import { readBulkOperation } from './bulk-operation-recovery-server';

const sessionEnv = () => env as Partial<SessionEnv>;
async function original(command: FilteredAddCommand) {
  const request = new Request(getRequest());
  if (await prepareSession(request, sessionEnv())) return null;
  if (
    !command.credential ||
    sessionSubject(request) !== command.sender ||
    !requestCsrfToken(request) ||
    request.headers.get('x-csrf-token') !== command.headers['x-csrf-token'] ||
    requestCsrfToken(request) !== command.headers['x-csrf-token']
  )
    return null;
  return originalEntryRestoreCredential(request, sessionEnv(), command.credential);
}

const captureNative = createServerFn({ method: 'POST', strict: false })
  .validator((data: { capture: FilteredAddCapture }) => data)
  .handler(async ({ data }): Promise<Awaited<ReturnType<FilteredAddPort['capture']>>> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const request = new Request(getRequest());
      if (await prepareSession(request, sessionEnv())) return { state: 'forbidden' };
      const sender = sessionSubject(request);
      const csrf = requestCsrfToken(request);
      if (!sender || !viewerCredential(request) || !csrf || request.headers.get('x-csrf-token') !== csrf)
        return { state: 'forbidden' };
      // Re-derive the typed query; never trust a client-carried body or a loaded row population.
      const input = data.capture;
      const capture = captureFilteredAdd(
        {
          id: input.request.selection.sourceId,
          ...(input.request.selection.filter === undefined
            ? {}
            : { filter: JSON.parse(input.request.selection.filter) }),
        },
        input.destination,
      );
      if (!capture.ok || capture.body !== input.body) return { state: 'changed' };
      const destination = await loadCollectionDestination(
        kernelClient(),
        request,
        sessionEnv(),
        capture.destination.id,
      );
      if (!destination || destination.revision !== capture.destination.revision) return { state: 'changed' };
      const credential = await captureEntryRestoreCredential(request, sessionEnv());
      if (!credential) return { state: 'forbidden' };
      return {
        state: 'captured',
        command: {
          capture,
          sender,
          credential,
          previewKey: crypto.randomUUID(),
          confirmKey: crypto.randomUUID(),
          headers: {
            'x-csrf-token': csrf,
            'accept-language': acceptLanguage(requestLocale(request) ?? 'en'),
            'content-type': 'application/json',
          },
        },
      };
    } catch {
      return { state: 'unavailable' };
    }
  });

const sendNative = createServerFn({ method: 'POST', strict: false })
  .validator((data: { command: FilteredAddCommand; operationId?: string }) => data)
  .handler(async ({ data }): Promise<FilteredAddResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const authorization = await original(data.command);
      if (!authorization) return { state: 'forbidden' };
      return sendFilteredAdd(kernelClient(), authorization, data.command, data.operationId);
    } catch {
      return { state: 'uncertain' };
    }
  });

export const filteredAddPort: FilteredAddPort = {
  capture: (capture, csrf) => captureNative({ data: { capture }, headers: { 'X-CSRF-Token': csrf } }),
  preview: (command) =>
    sendNative({ data: { command }, headers: { 'X-CSRF-Token': command.headers['x-csrf-token']! } }),
  confirm: (command, operationId) =>
    sendNative({ data: { command, operationId }, headers: { 'X-CSRF-Token': command.headers['x-csrf-token']! } }),
  read: async () => ({ state: 'unavailable' }),
};

/** Fresh read authority may observe the original operation, but cannot replace its write command. */
export function filteredAddReader(viewer: string): FilteredAddPort['read'] {
  return async (id, cursor) => {
    const result = await readBulkOperation({ data: { id, viewer, ...(cursor === undefined ? {} : { cursor }) } });
    return result.state === 'ready'
      ? result
      : { state: result.state === 'forbidden' ? 'forbidden' : result.state === 'expired' ? 'expired' : 'unavailable' };
  };
}
