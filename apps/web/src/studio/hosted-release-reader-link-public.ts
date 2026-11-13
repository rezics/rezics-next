import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { hasKernelOrigin, kernelClient } from '../kernel/client';
import { hostedId } from './hosted-contract';
import type { HostedReleaseReaderAdmission } from './hosted-release-reader-link';
import { publicHostedReleaseAdmission } from './hosted-release-reader-link-admission';

/** One anonymous metadata read, without author credentials, outline hydration or chapter resolution. */
export const readPublicHostedRelease = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(v.strictObject({ catalogueId: hostedId, releaseRevisionId: hostedId }), input))
  .handler(async ({ data }): Promise<boolean> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    if (!hasKernelOrigin()) return false;
    return publicHostedReleaseAdmission(kernelClient(), data, request.signal);
  });

export const admitPublicHostedRelease: HostedReleaseReaderAdmission = (data, signal) =>
  readPublicHostedRelease({ data, signal });
