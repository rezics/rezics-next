import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import {
  validateRealmClaimApproval,
  validateRealmClaimReviewRead,
  type RealmClaimApprovalInput,
} from './realm-claim-review';
import { approveRealmClaimReview, readRealmClaimReview, type RealmClaimReviewEnv } from './realm-claim-review-native';

export const readRealmClaimReviewPage = createServerFn({ method: 'GET' })
  .validator((input: { realmId: string; cursor?: string }) => validateRealmClaimReviewRead(input))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return readRealmClaimReview(kernelClient(), getRequest(), env as RealmClaimReviewEnv, data);
  });

export const submitRealmClaimApproval = createServerFn({ method: 'POST' })
  .validator((input: RealmClaimApprovalInput) => validateRealmClaimApproval(input))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return approveRealmClaimReview(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
