import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { loadMineFollowingPage, type MineFollowingPage, unfollowFollow } from './mine-following';

function validateInput(input: unknown): { cursor?: string } {
  if (
    !input ||
    typeof input !== 'object' ||
    ('cursor' in input &&
      input.cursor !== undefined &&
      (typeof input.cursor !== 'string' || input.cursor.length > 2048))
  )
    throw new Error('Invalid follows cursor');
  return 'cursor' in input && typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {};
}

export const readMineFollowingPage = createServerFn({ method: 'GET' })
  .validator(validateInput)
  .handler(async ({ data }): Promise<MineFollowingPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadMineFollowingPage(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

function validateUnfollow(input: unknown): { targetId: string; idempotencyKey: string } {
  if (
    !input ||
    typeof input !== 'object' ||
    !('targetId' in input) ||
    typeof input.targetId !== 'string' ||
    input.targetId.length === 0 ||
    input.targetId.length > 128 ||
    !('idempotencyKey' in input) ||
    typeof input.idempotencyKey !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey)
  )
    throw new Error('Invalid unfollow request');
  return { targetId: input.targetId, idempotencyKey: input.idempotencyKey };
}

export const unfollow = createServerFn({ method: 'POST' })
  .validator(validateUnfollow)
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false }> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    try {
      return (await unfollowFollow(kernelClient(), request, env as Partial<SessionEnv>, data))
        ? { ok: true }
        : { ok: false };
    } catch (error) {
      if (isPlatformClosedError(error)) return { ok: false };
      return { ok: false };
    }
  });
