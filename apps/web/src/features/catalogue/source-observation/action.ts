import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { inspectSourceObservation, validSourceObservationRequest } from './contract';
import { sourceObservationOperation } from './kernel';

export const inspectSubjectSourceObservation = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    if (!validSourceObservationRequest(input)) throw new Error('Invalid provider observation request');
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const { kernelClient, requestLocale } = await import('../../../kernel/client');
    return inspectSourceObservation(sourceObservationOperation(kernelClient(requestLocale() ?? 'en')), data);
  });
