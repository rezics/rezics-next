import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { hasKernelOrigin, kernelClient } from '../kernel/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import type { SessionEnv } from '../session/client';
import { hostedFailure } from './hosted-native';
import { hostedRootAppendNative } from './hosted-actions';
import { baselineRequest } from './hosted-legacy-baseline-contract';
import { baselineUnknown, createBaselineAdvance } from './hosted-legacy-baseline-native';
import type { BaselineTransport } from './hosted-legacy-baseline';

/** Session admission supplies the acting credential; expectedViewer is only a comparison operand. */
export const advanceHostedLegacyBaseline = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(baselineRequest, input))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const accountId = sessionSubject(request);
    const credential = viewerCredential(request);
    if (!accountId || !credential || accountId !== data.expectedViewer.accountId)
      return hostedFailure('denied', 'Sign in again to prepare this Book.');
    if (!hasKernelOrigin()) return hostedFailure('unavailable', 'The native Book service is not configured.');
    // Native admission checks ownership and the original version, including receipt replay.
    // A later owner read must never prevent recovery of an acknowledged command.
    return createBaselineAdvance(kernelClient(undefined, credential))(data, request.signal, '');
  });

export const hostedBaselineTransport: BaselineTransport = {
  readOwn: (...args) => hostedRootAppendNative.readOwn(...args),
  async advance(data, signal, csrfToken) {
    try {
      return await advanceHostedLegacyBaseline({ data, signal, headers: { 'X-CSRF-Token': csrfToken } });
    } catch {
      return baselineUnknown();
    }
  },
};
