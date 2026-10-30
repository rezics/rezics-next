import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { SessionEnv } from '../../session/client';
import { boundViewer } from '../profile-editor/request';
import { parseSelection, readErasureStatus, type Page } from './data';

export const readAccountErasure = createServerFn({ method: 'GET' })
  .validator(parseSelection)
  .handler(async ({ data }): Promise<Page> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const authorization = await boundViewer(getRequest(), env as Partial<SessionEnv>, data.viewerId);
      if (!authorization) return { status: 'signed-out' };
      // Native evaluates the current scope, principal, assignment, floor, denial and gate on every read.
      return readErasureStatus((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN, authorization, data);
    } catch {
      return { status: 'unavailable' };
    }
  });
