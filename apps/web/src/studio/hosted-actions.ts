import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { hasKernelOrigin, kernelClient } from '../kernel/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import type { SessionEnv } from '../session/client';
import type { StudioResult } from './contract';
import {
  hostedCreate,
  hostedId,
  hostedHistoryRequest,
  hostedOwnerBinding,
  hostedOwnerViewer,
  hostedKey,
  hostedPublish,
  hostedRevise,
  hostedSelection,
  type HostedBook,
  type HostedBookNative,
} from './hosted-contract';
import { createHostedBookNative, hostedFailure } from './hosted-native';

async function admitted(
  run: (native: HostedBookNative, signal: AbortSignal) => Promise<StudioResult<HostedBook>>,
  mutation = false,
): Promise<StudioResult<HostedBook>> {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  try {
    // This is also the existing Origin/CSRF boundary for server-function commands.
    await prepareSession(request, env as Partial<SessionEnv>);
    const credential = viewerCredential(request);
    if (!credential) return hostedFailure('denied', 'Sign in again to open this author workspace.');
    if (!hasKernelOrigin()) return hostedFailure('unavailable', 'The native book service is not configured.');
    return await run(createHostedBookNative(kernelClient(undefined, credential)), request.signal);
  } catch {
    return hostedFailure(
      mutation ? 'uncertain' : 'unavailable',
      mutation ? 'The command result is unknown. Retry the same operation.' : 'The author workspace is unavailable.',
    );
  }
}

export const readHostedBook = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(hostedSelection, input))
  .handler(({ data }) => admitted((native, signal) => native.read(data, signal)));

export const createHostedBook = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(v.strictObject({ body: hostedCreate, idempotencyKey: hostedKey }), input))
  .handler(({ data }) => admitted((native, signal) => native.create(data.body, data.idempotencyKey, signal), true));

export const reviseHostedBook = createServerFn({ method: 'POST' })
  .validator((input: unknown) =>
    v.parse(
      v.strictObject({
        catalogueId: hostedId,
        body: hostedRevise,
        idempotencyKey: hostedKey,
      }),
      input,
    ),
  )
  .handler(({ data }) =>
    admitted((native, signal) => native.revise(data.catalogueId, data.body, data.idempotencyKey, signal), true),
  );

export const publishHostedBook = createServerFn({ method: 'POST' })
  .validator((input: unknown) =>
    v.parse(
      v.strictObject({
        catalogueId: hostedId,
        body: hostedPublish,
        idempotencyKey: hostedKey,
      }),
      input,
    ),
  )
  .handler(({ data }) =>
    admitted((native, signal) => native.publish(data.catalogueId, data.body, data.idempotencyKey, signal), true),
  );

async function admittedOwner<T>(
  run: (native: HostedBookNative, accountId: string, signal: AbortSignal) => Promise<StudioResult<T>>,
): Promise<StudioResult<T>> {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  try {
    await prepareSession(request, env as Partial<SessionEnv>);
    const accountId = sessionSubject(request);
    const credential = viewerCredential(request);
    if (!accountId || !credential) return hostedFailure('denied', 'Sign in again to open this author workspace.');
    if (!hasKernelOrigin()) return hostedFailure('unavailable', 'The native book service is not configured.');
    return await run(createHostedBookNative(kernelClient(undefined, credential)), accountId, request.signal);
  } catch {
    return hostedFailure('unavailable', 'The author workspace is unavailable.');
  }
}

const ownerInventoryRequest = v.strictObject({
  accountId: v.optional(hostedId),
  expected: v.optional(hostedOwnerBinding),
  cursor: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
});
export const listHostedBooks = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(ownerInventoryRequest, input))
  .handler(({ data }) =>
    admittedOwner((native, accountId, signal) =>
      data.accountId && data.accountId !== accountId
        ? Promise.resolve(hostedFailure('denied', 'This book inventory belongs to a different account.'))
        : native.listOwn(accountId, data.cursor, signal, data.expected),
    ),
  );

/** History discovery is always an authenticated author action, even for a public release. */
export const listHostedBookHistory = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(hostedHistoryRequest, input))
  .handler(({ data }) =>
    admittedOwner((native, _accountId, signal) => native.listHistory(data.catalogueId, data.cursor, signal)),
  );

export const readOwnedHostedBook = createServerFn({ method: 'GET' })
  .validator((input: unknown) =>
    v.parse(
      v.strictObject({
        accountId: v.optional(hostedId),
        catalogueId: hostedId,
        expectedViewer: v.optional(hostedOwnerViewer),
      }),
      input,
    ),
  )
  .handler(({ data }) =>
    admittedOwner((native, accountId, signal) =>
      data.accountId && data.accountId !== accountId
        ? Promise.resolve(hostedFailure('denied', 'This book belongs to a different account.'))
        : native.readOwn(accountId, data.catalogueId, signal, data.expectedViewer),
    ),
  );

/** Browser callers receive admitted data only. Credentials remain inside the ordinary BFF session boundary. */
export const hostedBookNative: HostedBookNative = {
  listHistory: (catalogueId, cursor, signal) => listHostedBookHistory({ data: { catalogueId, cursor }, signal }),
  read: (data, signal) => readHostedBook({ data, signal }),
  listOwn: (accountId, cursor, signal, expected) => listHostedBooks({ data: { accountId, cursor, expected }, signal }),
  readOwn: (accountId, catalogueId, signal, expectedViewer) =>
    readOwnedHostedBook({ data: { accountId, catalogueId, expectedViewer }, signal }),
  create: (body, idempotencyKey, signal) => createHostedBook({ data: { body, idempotencyKey }, signal }),
  revise: (catalogueId, body, idempotencyKey, signal) =>
    reviseHostedBook({ data: { catalogueId, body, idempotencyKey }, signal }),
  publish: (catalogueId, body, idempotencyKey, signal) =>
    publishHostedBook({ data: { catalogueId, body, idempotencyKey }, signal }),
};
