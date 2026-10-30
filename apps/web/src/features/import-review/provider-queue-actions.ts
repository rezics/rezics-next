import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { readRelease } from '../../subject/definitions';
import {
  decideProviderCandidate,
  prepareProviderQueue,
  readProviderQueue,
  validQueueDecision,
  validQueueScope,
  type QueueScope,
  type QueueState,
} from './provider-queue';

async function viewer() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  return viewerCredential(request);
}
// Native reference values have an unknown input type; the generated HTTP client has already read JSON.
// Use the same JSON transport mode as the ordinary Subject page's typed server functions.
export const readProviderQueueAction = createServerFn({ method: 'GET', strict: false })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid review scope');
    const data = value as { scope: QueueScope; cursor?: string; session?: string };
    if (
      Object.keys(data).some((key) => !['scope', 'cursor', 'session'].includes(key)) ||
      !validQueueScope(data.scope) ||
      (data.cursor !== undefined && (typeof data.cursor !== 'string' || data.cursor.length > 4096)) ||
      (data.session !== undefined && (typeof data.session !== 'string' || data.session.length > 16384))
    )
      throw new Error('Invalid review scope');
    return data;
  })
  .handler(async ({ data }): Promise<QueueState> => {
    const authorization = await viewer();
    if (!authorization) return { state: 'denied' };
    return readProviderQueue(kernelClient(), authorization, readRelease(), data.scope, data.cursor, data.session);
  });
export const prepareProviderQueueAction = createServerFn({ method: 'POST', strict: false })
  .validator((value: unknown) => {
    if (!validQueueScope(value)) throw new Error('Invalid review scope');
    return value;
  })
  .handler(async ({ data }): Promise<QueueState> => {
    const authorization = await viewer();
    return authorization ? prepareProviderQueue(kernelClient(), authorization, data) : { state: 'denied' };
  });
export const decideProviderCandidateAction = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!validQueueDecision(value)) throw new Error('Invalid review decision');
    return value;
  })
  .handler(async ({ data }) => {
    const authorization = await viewer();
    return authorization
      ? decideProviderCandidate(kernelClient(), authorization, data)
      : { ok: false as const, reason: 'denied' as const };
  });
