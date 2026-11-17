import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { hasKernelOrigin, kernelClient } from '../kernel/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import type { SessionEnv } from '../session/client';
import { hostedPublicationPointNative, hostedRootAppendNative } from './hosted-actions';
import { hostedFailure } from './hosted-native';
import { activationRequest, type ActivationKind, type ActivationOperation } from './hosted-release-activation-contract';
import { activationUnknown, createHostedReleaseActivationTransport } from './hosted-release-activation-native';
import { admitPublicHostedRelease } from './hosted-release-reader-link-public';

export const commandHostedReleaseActivation = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(activationRequest, input))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const accountId = sessionSubject(request);
    const credential = viewerCredential(request);
    if (!accountId || !credential || accountId !== data.expectedViewer.accountId)
      return hostedFailure('denied', 'Sign in again to activate this Book.');
    if (!hasKernelOrigin()) return hostedFailure('unavailable', 'The native Book service is not configured.');
    const stage = kernelClient(undefined, credential)
      .hostedCatalogues({ id: data.catalogueId })
      .publicationPreparations({ stageId: data.stageId });
    const options = {
      headers: { 'idempotency-key': JSON.stringify(data.idempotencyKey) },
      fetch: { signal: request.signal, cache: 'no-store' as const, redirect: 'manual' as const },
    };
    // Native current admission governs exact receipt replay. A fresh owner read cannot settle or block that intent.
    try {
      const response =
        data.kind === 'start'
          ? await stage.$startActivation.post(data.body, options)
          : data.kind === 'advance'
            ? await stage.$advanceActivation.post(data.body, options)
            : await stage.$activate.post(data.body, options);
      if (response.status === 412) {
        const problem = response.error?.value;
        const reason = problem && typeof problem === 'object' && 'reason' in problem ? problem.reason : undefined;
        if (reason === 'catalogue_not_public' || reason === 'chapter_not_eligible')
          return { ok: false as const, error: { kind: 'stale' as const, message: 'Activation refused.', reason } };
        return hostedFailure('stale', 'The reviewed candidate or activation authority is no longer current.');
      }
      if (response.status === 401 || response.status === 403)
        return hostedFailure('denied', 'This author session cannot activate the Book.');
      if (response.status === 404)
        return hostedFailure(
          'unavailable',
          'This private candidate is unavailable under the current author admission.',
        );
      if ([400, 409, 413, 422].includes(response.status))
        return hostedFailure('invalid', 'The activation command was rejected.');
      if (response.status !== 200 || response.error) return activationUnknown();
      // The shared activation boundary binds this external reply to the original stage and candidate generation.
      return { ok: true as const, value: response.data };
    } catch {
      return activationUnknown();
    }
  });

function activationOperation(kind: ActivationKind): ActivationOperation {
  return async (input, signal, csrfToken) => {
    try {
      return await commandHostedReleaseActivation({
        data: { ...input, kind },
        signal,
        headers: { 'X-CSRF-Token': csrfToken },
      });
    } catch {
      return activationUnknown();
    }
  };
}

export const hostedReleaseActivationTransport = createHostedReleaseActivationTransport({
  startHostedPublicationActivation: activationOperation('start'),
  advanceHostedPublicationActivationAuthority: activationOperation('advance'),
  activateHostedPublicationCandidate: activationOperation('activate'),
  readOwn: (...args) => hostedRootAppendNative.readOwn(...args),
  readMetadata: (...args) => hostedPublicationPointNative.readMetadata(...args),
  admitPublic: admitPublicHostedRelease,
});
