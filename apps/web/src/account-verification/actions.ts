import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { readAccount, readOperations, readPending, performOperation, validOperation } from './transport';
import { withVerificationDeadline } from './deadline';

export {
  requestVerificationAction,
  withdrawVerificationAction,
  readVerificationState,
} from '../settings/verification-actions';

async function viewer() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  // Unsafe calls pass the same Origin/session/CSRF boundary as the existing BFF.
  await withVerificationDeadline(() => prepareSession(request, env as Partial<SessionEnv>), request.signal);
  const authorization = viewerCredential(request);
  const viewerId = sessionSubject(request);
  if (!authorization || !viewerId) return null;
  return { authorization, viewerId };
}

export const readReviewPage = createServerFn({ method: 'GET' })
  .validator((value: unknown): { cursor?: string } => {
    if (!value || typeof value !== 'object' || Object.keys(value).some((key) => key !== 'cursor'))
      throw new Error('Invalid page');
    const { cursor } = value as { cursor?: unknown };
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 4096)) throw new Error('Invalid cursor');
    return cursor === undefined ? {} : { cursor };
  })
  .handler(async ({ data }) => {
    const identity = await viewer();
    if (!identity) return { viewerId: null, page: { state: 'denied' as const }, operations: [] as string[] };
    const client = kernelClient();
    const caller = getRequest().signal;
    const [operations, page] = await Promise.all([
      readOperations(client, identity.authorization, caller),
      readPending(client, identity.authorization, data.cursor, caller),
    ]);
    return { viewerId: identity.viewerId, page, operations: operations.state === 'ready' ? operations.value : [] };
  });

const accountId = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new Error('Invalid account');
  return value;
};
export const readAccountVerificationPage = createServerFn({ method: 'GET' })
  .validator((value: unknown) => accountId(value))
  .handler(async ({ data }) => {
    const identity = await viewer();
    if (!identity) return { viewerId: null, page: { state: 'denied' as const } };
    return {
      viewerId: identity.viewerId,
      page: {
        state: 'ready' as const,
        value: await readAccount(kernelClient(), identity.authorization, data, getRequest().signal),
      },
    };
  });

export const readAccountManagement = createServerFn({ method: 'GET' }).handler(async () => {
  const identity = await viewer();
  return identity ? { state: 'ready' as const, value: identity.viewerId } : { state: 'denied' as const };
});

export const decideVerification = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!validOperation(value)) throw new Error('Invalid verification operation');
    return value;
  })
  .handler(async ({ data }) => {
    const identity = await viewer();
    if (!identity) return { state: 'denied' as const };
    return performOperation(kernelClient(), identity.authorization, data, getRequest().signal);
  });
