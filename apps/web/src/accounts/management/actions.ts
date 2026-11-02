import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { prepareSession, viewerCredential } from '../../session/request';
import type { SessionEnv } from '../../session/client';
import {
  loadDetail,
  loadInventory,
  loadOrganizationsAvailable,
  readCursors,
  type Cursors,
  type Page,
  type Detail,
  type Inventory,
} from './data';

async function reader() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  return viewerCredential(request);
}
function validateCursors(value: unknown): Cursors {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid page');
  return readCursors(value as Record<string, unknown>);
}

export const readManagedAccounts = createServerFn({ method: 'GET' })
  .validator(validateCursors)
  .handler(async ({ data }): Promise<Page<Inventory>> => {
    try {
      const signal = getRequest().signal;
      const authorization = await reader();
      if (!authorization) return { state: 'signed-out' };
      const page = await loadInventory(kernelClient(), authorization, data, signal);
      if (page.state !== 'ready') return page;
      const organizationsAvailable = await loadOrganizationsAvailable(kernelClient(), authorization, signal);
      if (signal.aborted) return { state: 'unavailable' };
      return { ...page, issuer: (env as Partial<SessionEnv>).AUTH_ISSUER ?? null, organizationsAvailable };
    } catch {
      return { state: 'unavailable' };
    }
  });

export const readAccountManagement = createServerFn({ method: 'GET' })
  .validator((value: unknown) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('accountId' in value) ||
      typeof value.accountId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.accountId)
    )
      throw new Error('Invalid account');
    return { accountId: value.accountId, ...validateCursors(value) };
  })
  .handler(async ({ data }): Promise<Page<Detail>> => {
    try {
      const signal = getRequest().signal;
      const authorization = await reader();
      if (!authorization) return { state: 'signed-out' };
      const page = await loadDetail(kernelClient(), authorization, data.accountId, data, signal);
      return page.state === 'ready'
        ? { ...page, issuer: (env as Partial<SessionEnv>).AUTH_ISSUER ?? null, organizationsAvailable: null }
        : page;
    } catch {
      return { state: 'unavailable' };
    }
  });
