import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { inspectSourceObservation, validSourceObservationRequest } from './contract';

/**
 * The mounted Kernel route is ahead of @rezics/client's generated declaration.
 * Keep the caller typed and explicit until that declaration is delivered; never
 * substitute an ad-hoc URL or a client cast here.
 */
export const inspectSubjectSourceObservation = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    if (!validSourceObservationRequest(input)) throw new Error('Invalid provider observation request');
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return inspectSourceObservation(null, data);
  });
