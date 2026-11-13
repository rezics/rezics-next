import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { hasKernelOrigin, kernelClient } from '../kernel/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import type { SessionEnv } from '../session/client';
import { hostedRootAppendNative } from './hosted-actions';
import { hostedFailure } from './hosted-native';
import { releaseRequest } from './hosted-release-preparation-contract';
import { createReleaseCommand, releaseUnknown } from './hosted-release-preparation-native';
import type { ReleaseTransport } from './hosted-release-preparation';

export const commandHostedReleasePreparation = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(releaseRequest, input))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const accountId = sessionSubject(request);
    const credential = viewerCredential(request);
    if (!accountId || !credential || accountId !== data.expectedViewer.accountId)
      return hostedFailure('denied', 'Sign in again to prepare this Book.');
    if (!hasKernelOrigin()) return hostedFailure('unavailable', 'The native Book service is not configured.');
    // Current native admission precedes receipt replay; owner readback must not prevent an exact retry.
    return createReleaseCommand(kernelClient(undefined, credential))(data, request.signal, '');
  });

export const hostedReleaseTransport: ReleaseTransport = {
  readOwn: (...args) => hostedRootAppendNative.readOwn(...args),
  async command(data, signal, csrfToken) {
    try {
      return await commandHostedReleasePreparation({ data, signal, headers: { 'X-CSRF-Token': csrfToken } });
    } catch {
      return releaseUnknown();
    }
  },
};
