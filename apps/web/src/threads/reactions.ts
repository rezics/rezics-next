import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client.ts';
import { changeReactionRequest, validateReaction, type ReactionFailure } from './reaction-request';

export const changeReaction = createServerFn({ method: 'POST' })
  .validator(validateReaction)
  .handler(async ({ data }): Promise<{ ok: true } | ReactionFailure> => {
    setResponseHeader('cache-control', 'private, no-store');
    return changeReactionRequest(data, getRequest(), env as Partial<SessionEnv>, kernelClient());
  });
