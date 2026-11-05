import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client.ts';
import {
  changeReactionRequest,
  readReactionRequest,
  validateReaction,
  type ChangeReactionInput,
  type ReactionFailure,
  type ReactionSnapshot,
} from './reaction-request';

export const changeReaction = createServerFn({ method: 'POST' })
  .validator(validateReaction)
  .handler(async ({ data }): Promise<{ ok: true } | ReactionFailure> => {
    setResponseHeader('cache-control', 'private, no-store');
    const command: ChangeReactionInput = data;
    return changeReactionRequest(command, getRequest(), env as Partial<SessionEnv>, kernelClient());
  });

export const readReaction = createServerFn({ method: 'POST' })
  .validator(validateReaction)
  .handler(async ({ data }): Promise<ReactionSnapshot | ReactionFailure> => {
    setResponseHeader('cache-control', 'private, no-store');
    return readReactionRequest(data, getRequest(), env as Partial<SessionEnv>, kernelClient());
  });
