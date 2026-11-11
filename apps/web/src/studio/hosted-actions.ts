import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { hasKernelOrigin, kernelClient } from '../kernel/client';
import { prepareSession, viewerCredential } from '../session/request';
import type { SessionEnv } from '../session/client';
import type { StudioResult } from './contract';
import {
  hostedCreate, hostedId, hostedKey, hostedPublish, hostedRevise, hostedSelection,
  type HostedBook, type HostedBookNative,
} from './hosted-contract';
import { createHostedBookNative, hostedFailure } from './hosted-native';

async function admitted(run: (native: HostedBookNative, signal: AbortSignal) => Promise<StudioResult<HostedBook>>,
  mutation = false): Promise<StudioResult<HostedBook>> {
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
    return hostedFailure(mutation ? 'uncertain' : 'unavailable', mutation
      ? 'The command result is unknown. Retry the same operation.' : 'The author workspace is unavailable.');
  }
}

export const readHostedBook = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(hostedSelection, input))
  .handler(({ data }) => admitted((native, signal) => native.read(data, signal)));

export const createHostedBook = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(v.strictObject({ body: hostedCreate, idempotencyKey: hostedKey }), input))
  .handler(({ data }) => admitted((native, signal) => native.create(data.body, data.idempotencyKey, signal), true));

export const reviseHostedBook = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(v.strictObject({
    catalogueId: hostedId, body: hostedRevise, idempotencyKey: hostedKey,
  }), input))
  .handler(({ data }) => admitted((native, signal) => native.revise(data.catalogueId, data.body, data.idempotencyKey, signal), true));

export const publishHostedBook = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(v.strictObject({
    catalogueId: hostedId, body: hostedPublish, idempotencyKey: hostedKey,
  }), input))
  .handler(({ data }) => admitted((native, signal) => native.publish(data.catalogueId, data.body, data.idempotencyKey, signal), true));

/** Browser callers receive admitted data only. Credentials remain inside the ordinary BFF session boundary. */
export const hostedBookNative: HostedBookNative = {
  read: (data, signal) => readHostedBook({ data, signal }),
  create: (body, idempotencyKey, signal) => createHostedBook({ data: { body, idempotencyKey }, signal }),
  revise: (catalogueId, body, idempotencyKey, signal) => reviseHostedBook({ data: { catalogueId, body, idempotencyKey }, signal }),
  publish: (catalogueId, body, idempotencyKey, signal) => publishHostedBook({ data: { catalogueId, body, idempotencyKey }, signal }),
};
