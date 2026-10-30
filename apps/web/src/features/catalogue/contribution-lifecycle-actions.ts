import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import {
  changeContribution,
  contributionAddressInput,
  contributionInput,
  readContributionAvailability,
  type ContributionAvailability,
  type ContributionResult,
} from './contribution-lifecycle';

async function credential() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  return viewerCredential(request);
}

// Existing POST session middleware supplies origin and CSRF checks. No credentials cross this BFF.
export const changeOwnContribution = createServerFn({ method: 'POST', strict: false })
  .validator(contributionInput)
  .handler(async ({ data }): Promise<ContributionResult> => {
    const authorization = await credential();
    if (!authorization) return { ok: false, reason: 'denied' };
    return changeContribution(kernelClient(), authorization, data);
  });

export const rereadOwnContribution = createServerFn({ method: 'POST', strict: false })
  .validator((value: unknown) => {
    const input = contributionAddressInput(value);
    if (Object.keys(value as object).some((key) => !['id', 'candidate', 'property', 'session'].includes(key)))
      throw new Error('Invalid contribution address');
    return input;
  })
  .handler(async ({ data }): Promise<ContributionAvailability> => {
    const authorization = await credential();
    if (!authorization) return { subject: 'unavailable', candidate: 'unconfirmed', selected: null };
    return readContributionAvailability(kernelClient(), authorization, data);
  });
