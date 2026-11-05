import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { loadCurrentFollowState, loadFollowState, validFollowInput, writeFollowRecord } from './follow-records';

function targetId(input: { targetId: string }): { targetId: string } {
  if (typeof input?.targetId !== 'string' || input.targetId.length === 0 || input.targetId.length > 128)
    throw new Error('Invalid follow target');
  return { targetId: input.targetId };
}

export const readFollowState = createServerFn({ method: 'GET' })
  .validator(targetId)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadFollowState(kernelClient(), getRequest(), env as Partial<SessionEnv>, data.targetId);
  });

export const readCurrentFollowState = createServerFn({ method: 'GET' })
  .validator(targetId)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadCurrentFollowState(kernelClient(), getRequest(), env as Partial<SessionEnv>, data.targetId);
  });

export const setFollow = createServerFn({ method: 'POST' })
  .validator((input: { targetId: string; following: boolean; idempotencyKey: string }) => {
    targetId(input);
    if (typeof input.following !== 'boolean' || typeof input.idempotencyKey !== 'string' || !validFollowInput(input))
      throw new Error('Invalid follow request');
    return { targetId: input.targetId, following: input.following, idempotencyKey: input.idempotencyKey };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return writeFollowRecord(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
