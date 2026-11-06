import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import {
  changeZoneLifecycle,
  changeZoneTakedown,
  type ZoneLifecycleAddress,
  type ZoneLifecycleClient,
  type ZoneLifecycleResult,
  type ZoneTakedownCommand,
} from './lifecycle-zone-commands.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const revision = /^[1-9][0-9]*$/;

function address(value: ZoneLifecycleAddress): ZoneLifecycleAddress {
  if (!uuid.test(value.id) || !revision.test(value.revision) || !uuid.test(value.key))
    throw new Error('Invalid Zone lifecycle command');
  return { id: value.id, revision: value.revision, key: value.key };
}

async function authorization(): Promise<string | null> {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  const stale = await prepareSession(request, env as Partial<SessionEnv>);
  return stale ? null : viewerCredential(request);
}

function client(): ZoneLifecycleClient {
  return kernelClient() as unknown as ZoneLifecycleClient;
}

export const changeOwnZoneLifecycle = createServerFn({ method: 'POST', strict: false })
  .validator((value: ZoneLifecycleAddress & { operation: 'delete' | 'restore' }) => {
    const next = address(value);
    if (value.operation !== 'delete' && value.operation !== 'restore') throw new Error('Invalid Zone lifecycle');
    return { ...next, operation: value.operation };
  })
  .handler(async ({ data }): Promise<ZoneLifecycleResult> => {
    const token = await authorization();
    if (!token) return { ok: false, reason: 'denied' };
    return changeZoneLifecycle(client(), token, data);
  });

export const changeOwnZoneTakedown = createServerFn({ method: 'POST', strict: false })
  .validator((value: ZoneTakedownCommand & { operation: 'takedown' | 'release' }) => {
    const next = address(value);
    if (
      (value.operation !== 'takedown' && value.operation !== 'release') ||
      !Array.isArray(value.pointers) ||
      value.pointers.length < 1 ||
      value.pointers.length > 16
    )
      throw new Error('Invalid Zone takedown');
    return { ...next, pointers: value.pointers, operation: value.operation };
  })
  .handler(async ({ data }): Promise<ZoneLifecycleResult> => {
    const token = await authorization();
    if (!token) return { ok: false, reason: 'denied' };
    return changeZoneTakedown(client(), token, data);
  });
