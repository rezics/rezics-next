import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import {
  enqueueAuthorErasure,
  readAuthorErasure,
  validErasureId,
  type ErasureEnqueue,
  type ErasureRead,
} from './author-erasure';
import { currentAuthorErasureAdmission, type AuthorErasureAdmission } from './author-erasure-admission';
import { authorErasureIdentity } from './author-erasure-session';

export const beginThreadAuthorErasure = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('threadId' in input) ||
      !validErasureId(input.threadId) ||
      !('idempotencyKey' in input) ||
      typeof input.idempotencyKey !== 'string' ||
      !/^[\x21-\x7e]{1,255}$/.test(input.idempotencyKey)
    )
      throw new Error('Invalid erasure request');
    return { threadId: input.threadId, idempotencyKey: input.idempotencyKey };
  })
  .handler(async ({ data }): Promise<ErasureEnqueue> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    // Unsafe prepareSession enforces the ordinary native session's origin and CSRF token.
    const session = await authorErasureIdentity(request, env as Partial<SessionEnv>);
    if (session.kind !== 'available') return session;
    if (!(env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN) return { kind: 'unavailable' };
    return enqueueAuthorErasure(kernelClient(), session.identity, data);
  });

export const readThreadAuthorErasure = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object' || !('id' in input) || !validErasureId(input.id))
      throw new Error('Invalid operation');
    return { id: input.id };
  })
  .handler(async ({ data }): Promise<ErasureRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const request = getRequest();
      const session = await authorErasureIdentity(request, env as Partial<SessionEnv>);
      if (session.kind !== 'available') return session;
      if (!(env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN) return { kind: 'unavailable' };
      return readAuthorErasure(kernelClient(), session.identity.authorization, data.id);
    } catch {
      return { kind: 'unavailable' };
    }
  });

/** Safe session preparation: no bearer is accepted from the browser. */
export const readThreadAuthorErasureAdmission = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object' || !('threadId' in input) || !validErasureId(input.threadId))
      throw new Error('Invalid thread');
    return { threadId: input.threadId };
  })
  .handler(async ({ data }): Promise<AuthorErasureAdmission> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const session = await authorErasureIdentity(getRequest(), env as Partial<SessionEnv>);
      if (session.kind !== 'available') return session;
      if (!(env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN) return { kind: 'unavailable' };
      return currentAuthorErasureAdmission(kernelClient(), session.identity, data.threadId);
    } catch {
      return { kind: 'unavailable' };
    }
  });
