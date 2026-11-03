import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { readSubjectSlotSession } from '../subject-slot';
import {
  cancelDiaryContinuation,
  readConsumptionSummary,
  readDiaryPage,
  type ConsumptionSummary,
  type DiaryPage,
} from './native';

type PrivateIdentity = { viewer: string; csrfToken: string; authorization: string };

async function currentIdentity(): Promise<PrivateIdentity | null> {
  const identity = await readSubjectSlotSession(getRequest(), env as Partial<SessionEnv>);
  return identity.state === 'signed-in' && identity.csrfToken
    ? { viewer: identity.subject, csrfToken: identity.csrfToken, authorization: identity.authorization }
    : null;
}

export type PrivateDiaryLoad = {
  kind: 'ready';
  viewer: string;
  csrfToken: string;
  diary: { kind: 'ready'; page: DiaryPage } | { kind: 'stale' | 'retired' | 'unavailable' };
  summary: { kind: 'ready'; value: ConsumptionSummary } | { kind: 'retired' | 'unavailable' };
};

export type PrivateDiaryLoadResult = PrivateDiaryLoad | { kind: 'signed-out' | 'unavailable' };

export const readPrivateDiary = createServerFn({ method: 'GET' })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { cursor: undefined };
    if (!('cursor' in value) || value.cursor === undefined) return { cursor: undefined };
    if (typeof value.cursor !== 'string' || value.cursor.length > 4096) throw new Error('Invalid diary cursor');
    return { cursor: value.cursor };
  })
  .handler(async ({ data }): Promise<PrivateDiaryLoadResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await currentIdentity();
    if (!identity) return { kind: 'signed-out' };
    const client = kernelClient();
    const [diary, summary] = await Promise.all([
      readDiaryPage(client, identity.authorization, data.cursor).catch(() => ({ kind: 'unavailable' as const })),
      readConsumptionSummary(client, identity.authorization).catch(() => ({ kind: 'unavailable' as const })),
    ]);
    return {
      kind: 'ready',
      viewer: identity.viewer,
      csrfToken: identity.csrfToken,
      diary,
      summary:
        summary.kind === 'ready'
          ? { kind: 'ready', value: summary.summary }
          : summary.kind === 'retired'
            ? { kind: 'retired' }
            : { kind: 'unavailable' },
    };
  });

export const cancelPrivateDiary = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid diary cancellation');
    const item = value as Record<string, unknown>;
    if (
      typeof item.viewer !== 'string' ||
      typeof item.csrfToken !== 'string' ||
      typeof item.continuation !== 'string' ||
      item.continuation.length < 1 ||
      item.continuation.length > 8192
    )
      throw new Error('Invalid diary cancellation');
    return { viewer: item.viewer, csrfToken: item.csrfToken, continuation: item.continuation };
  })
  .handler(async ({ data }): Promise<'cancelled' | 'retired' | 'unavailable'> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await currentIdentity();
    if (!identity || identity.viewer !== data.viewer || identity.csrfToken !== data.csrfToken) return 'retired';
    try {
      return await cancelDiaryContinuation(kernelClient(), identity.authorization, data.continuation);
    } catch {
      return 'unavailable';
    }
  });
