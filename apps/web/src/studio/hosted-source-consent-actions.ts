import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { hasKernelOrigin, kernelClient } from '../kernel/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import type { SessionEnv } from '../session/client';
import { hostedFailure } from './hosted-native';
import { sourceConsentRequest } from './hosted-source-consent-contract';
import { createSourceConsentTransport, sourceConsentUnknown } from './hosted-source-consent-native';
import type { SourceConsentTransport } from './hosted-source-consent';

export const commandHostedSourceConsent = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(sourceConsentRequest, input))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const accountId = sessionSubject(request);
    const credential = viewerCredential(request);
    if (!accountId || !credential || accountId !== data.expectedViewer.accountId)
      return hostedFailure('denied', 'Sign in again to review this source permission.');
    if (!hasKernelOrigin()) return hostedFailure('unavailable', 'The native source service is not configured.');
    // The source Post admits both commands and exact replay. Book ownership cannot grant source authority.
    return createSourceConsentTransport(kernelClient(undefined, credential))(data, request.signal, '');
  });

export const hostedSourceConsentTransport: SourceConsentTransport = async (data, signal, csrfToken) => {
  try {
    return await commandHostedSourceConsent({ data, signal, headers: { 'X-CSRF-Token': csrfToken } });
  } catch {
    return sourceConsentUnknown();
  }
};
