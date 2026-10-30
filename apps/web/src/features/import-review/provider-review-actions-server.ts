import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import {
  decideProviderCandidate,
  providerDecisionInput,
  providerFailure,
  readProviderDecisionSubjects,
  type ProviderDecisionResult,
} from './provider-review-actions';
import { readProviderQueue, type ProviderQueueRead } from './provider-queue';

async function caller() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  try {
    await prepareSession(request, env as Partial<SessionEnv>);
    return viewerCredential(request) ?? providerFailure(401);
  } catch (error) {
    return providerFailure(error instanceof Response ? error.status : 503);
  }
}

export const confirmProviderDecision = createServerFn({ method: 'POST', strict: false })
  .validator(providerDecisionInput)
  .handler(async ({ data }): Promise<ProviderDecisionResult> => {
    const authorization = await caller();
    if (typeof authorization !== 'string') return authorization;
    return decideProviderCandidate(kernelClient(), authorization, data);
  });

export const loadProviderQueue = createServerFn({ method: 'POST', strict: false }).handler(
  async (): Promise<ProviderQueueRead> => {
    const authorization = await caller();
    if (typeof authorization !== 'string') return authorization;
    return readProviderQueue();
  },
);

export const refreshProviderQueue = createServerFn({ method: 'POST', strict: false })
  .validator((value: unknown) => {
    if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid provider refresh');
    return value.map(providerDecisionInput);
  })
  .handler(async ({ data }) => {
    const authorization = await caller();
    if (typeof authorization !== 'string') return { queue: authorization, readings: [] };
    // The actual current readings and queue preparation are independent, bounded reads.
    const [queue, readings] = await Promise.all([
      readProviderQueue(),
      readProviderDecisionSubjects(kernelClient(), authorization, data),
    ]);
    return { queue, readings };
  });
