import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient } from '../../kernel/client';
import {
  changeContribution,
  contributionAddressInput,
  contributionInput,
  readContributionAvailability,
  type ContributionAvailability,
  type ContributionResult,
} from './contribution-lifecycle';

// Existing POST session middleware supplies origin and CSRF checks. No credentials cross this BFF.
export const changeOwnContribution = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput(contributionInput))
  .handler(async ({ data }): Promise<ContributionResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    return changeContribution(kernelClient(), authorization, data);
  });

export const rereadOwnContribution = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((value: unknown) => {
      const input = contributionAddressInput(value);
      if (Object.keys(value as object).some((key) => !['id', 'candidate', 'property', 'session'].includes(key)))
        throw new Error('Invalid contribution address');
      return input;
    }),
  )
  .handler(async ({ data }): Promise<ContributionAvailability> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { subject: 'unavailable', candidate: 'unconfirmed', selected: null };
    return readContributionAvailability(kernelClient(), authorization, data);
  });
