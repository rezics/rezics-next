import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import {
  RECOVERY_ID,
  RECOVERY_PAGE_ROWS,
  RECOVERY_UPLOAD_BASE64_CHARS,
  type RecoveryEffectCommand,
  type RecoveryPort,
  type RecoveryResult,
} from './contract';

type Api = KernelClient['libraryArchiveCollectionRecoveries'];
type Root = ReturnType<Api>;
type Occurrences = ReturnType<Root['collections']>;
type NativeResult<T> = { data: T | null; error: unknown; status: number };

const probeId = '00000000-0000-4000-8000-000000000000';

/** Only a fully mounted generated API enables the visit. No endpoint shape is invented here. */
export function nativeArchiveCollectionRecovery(client: KernelClient): Api | undefined {
  const api = client.libraryArchiveCollectionRecoveries;
  if (typeof api !== 'function' || typeof api.post !== 'function') return undefined;
  try {
    const root = api({ id: probeId });
    const occurrences = root.collections({ collectionId: probeId }).occurrences;
    if (
      typeof root.get !== 'function' ||
      typeof root.collections.get !== 'function' ||
      typeof occurrences?.get !== 'function' ||
      typeof root.review?.post !== 'function' ||
      typeof root.apply?.post !== 'function' ||
      typeof root.outcomes?.get !== 'function' ||
      typeof root.delete !== 'function'
    )
      return undefined;
    return api;
  } catch {
    return undefined;
  }
}

function failure(status: number): RecoveryResult<never> {
  if (status === 401 || status === 403) return { kind: 'denied' };
  if (status === 404) return { kind: 'not-found' };
  if (status === 409 || status === 422) return { kind: 'conflict' };
  if (status === 400) return { kind: 'invalid' };
  return { kind: 'unavailable' };
}

async function identity(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
): Promise<string | undefined> {
  if (!originConfigured) return undefined;
  try {
    await prepareSession(request, sessionEnv);
    return viewerCredential(request) ?? undefined;
  } catch {
    return undefined;
  }
}

function isId(value: string): boolean {
  return RECOVERY_ID.test(value);
}

/** Bind Web's exact review and native bounded page operations to the installed Eden methods. */
export function kernelArchiveCollectionRecoveryPort(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
): RecoveryPort {
  async function call<T>(input: {
    mutation?: RecoveryEffectCommand;
    send: (api: Api, authorization: string) => Promise<NativeResult<T>>;
  }): Promise<RecoveryResult<T>> {
    const authorization = await identity(request, sessionEnv, originConfigured);
    const api = nativeArchiveCollectionRecovery(client);
    if (!authorization || !api) return { kind: 'unavailable' };
    try {
      const result = await input.send(api, authorization);
      if (result.error) {
        if (input.mutation && (result.status === 0 || result.status >= 500))
          return { kind: 'unknown', command: structuredClone(input.mutation) };
        return failure(result.status);
      }
      return result.data === null ? { kind: 'unavailable' } : { kind: 'ok', value: result.data };
    } catch (error) {
      if (isPlatformClosedError(error)) return { kind: 'unavailable' };
      return input.mutation ? { kind: 'unknown', command: structuredClone(input.mutation) } : { kind: 'unavailable' };
    }
  }

  const readHeaders = (authorization: string) => ({ authorization });
  const writeHeaders = (authorization: string, key: string) => ({
    authorization,
    'idempotency-key': JSON.stringify(key),
  });
  const effectHeaders = (authorization: string) => ({ authorization });
  const idOf = (uploadId: string) => (isId(uploadId) ? uploadId : '');

  return {
    upload(command) {
      if (command.body.archiveBase64.length > RECOVERY_UPLOAD_BASE64_CHARS) return Promise.resolve({ kind: 'invalid' });
      return call({
        mutation: command,
        send: (api, authorization) => api.post(command.body, { headers: writeHeaders(authorization, command.key) }),
      });
    },
    status(uploadId) {
      const id = idOf(uploadId);
      if (!id) return Promise.resolve({ kind: 'not-found' });
      return call({ send: (api, authorization) => api({ id }).get({ headers: readHeaders(authorization) }) });
    },
    collections(uploadId, query) {
      const id = idOf(uploadId);
      if (!id) return Promise.resolve({ kind: 'not-found' });
      if (query.limit !== RECOVERY_PAGE_ROWS || (query.cursor && query.cursor.length > 4_096))
        return Promise.resolve({ kind: 'invalid' });
      return call({
        send: (api, authorization) => api({ id }).collections.get({ query, headers: readHeaders(authorization) }),
      });
    },
    occurrences(uploadId, collectionId, query) {
      const id = idOf(uploadId);
      if (!id || !isId(collectionId)) return Promise.resolve({ kind: 'not-found' });
      if (query.limit !== RECOVERY_PAGE_ROWS || (query.cursor && query.cursor.length > 4_096))
        return Promise.resolve({ kind: 'invalid' });
      return call({
        send: (api, authorization) =>
          api({ id })
            .collections({ collectionId })
            .occurrences.get({ query, headers: readHeaders(authorization) }),
      });
    },
    review(command) {
      if (!isId(command.uploadId)) return Promise.resolve({ kind: 'not-found' });
      return call({
        mutation: command,
        send: (api, authorization) =>
          api({ id: command.uploadId }).review.post(command.body, {
            headers: writeHeaders(authorization, command.key),
          }),
      });
    },
    apply(command) {
      if (!isId(command.uploadId)) return Promise.resolve({ kind: 'not-found' });
      return call({
        mutation: command,
        send: (api, authorization) =>
          api({ id: command.uploadId }).apply.post(command.body, { headers: effectHeaders(authorization) }),
      });
    },
    outcomes(uploadId, query) {
      const id = idOf(uploadId);
      if (!id) return Promise.resolve({ kind: 'not-found' });
      if (query.limit !== RECOVERY_PAGE_ROWS || (query.cursor && query.cursor.length > 4_096))
        return Promise.resolve({ kind: 'invalid' });
      return call({
        send: (api, authorization) => api({ id }).outcomes.get({ query, headers: readHeaders(authorization) }),
      });
    },
    cancel(command) {
      if (!isId(command.uploadId)) return Promise.resolve({ kind: 'not-found' });
      return call({
        mutation: command,
        send: (api, authorization) =>
          api({ id: command.uploadId }).delete(undefined, { headers: effectHeaders(authorization) }),
      });
    },
  };
}
