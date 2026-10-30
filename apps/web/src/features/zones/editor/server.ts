import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { UI_LOCALES } from '@rezics/composition';
import { kernelClient } from '../../../kernel/client';
import type { SessionEnv } from '../../../session/client';
import { prepareSession, viewerCredential } from '../../../session/request';
import { readRelease } from '../../../subject/definitions';
import { caught, collections, loadConfiguration, mutate, preview } from './api';
import { unavailable, validRevision, type Loaded, type Mutation } from './model';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function input(value: { id: string; locale: string }) {
  if (!uuid.test(value.id) || !(UI_LOCALES as readonly string[]).includes(value.locale))
    throw new Error('Invalid Zone request');
  return value;
}
async function credential() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  const stale = await prepareSession(request, env as Partial<SessionEnv>);
  return stale ? null : viewerCredential(request);
}
const denied = { kind: 'failure', status: 401, code: 'unauthorized' } as const;
function noResource(resource = unavailable): Loaded {
  return {
    resource,
    permissions: { configure: false, publish: false, available: false },
    options: { scopes: resource, collections: resource },
  };
}
export const readConfiguration = createServerFn({ method: 'GET', strict: false })
  .validator(input)
  .handler(async ({ data }): Promise<Loaded> => {
    try {
      const authorization = await credential();
      if (!authorization) return noResource(denied);
      return loadConfiguration(kernelClient(data.locale), data.id, authorization, readRelease);
    } catch (error) {
      return noResource(caught(error));
    }
  });
export const writeConfiguration = createServerFn({ method: 'POST' })
  .validator((value: Mutation & { locale: string }) => {
    input(value);
    if (
      !validRevision(value.revision) ||
      !/^[0-9a-f-]{36}$/.test(value.key) ||
      !['save', 'publish'].includes(value.operation)
    )
      throw new Error('Invalid Zone mutation');
    return value;
  })
  .handler(async ({ data }) => {
    try {
      const authorization = await credential();
      return authorization ? await mutate(kernelClient(data.locale), authorization, data) : denied;
    } catch (error) {
      return caught(error);
    }
  });
export const readSavedPreview = createServerFn({ method: 'GET', strict: false })
  .validator((value: { id: string; locale: string; route: string }) => {
    input(value);
    if (typeof value.route !== 'string' || value.route.length > 255) throw new Error('Invalid Zone route');
    return value;
  })
  .handler(async ({ data }) => {
    try {
      const authorization = await credential();
      return authorization
        ? await preview(kernelClient(data.locale), authorization, data.id, data.route, data.locale)
        : denied;
    } catch (error) {
      return caught(error);
    }
  });
export const readMountChoices = createServerFn({ method: 'GET' })
  .validator((value: { locale: string; cursor: string }) => {
    if (
      !(UI_LOCALES as readonly string[]).includes(value.locale) ||
      typeof value.cursor !== 'string' ||
      value.cursor.length > 8192
    )
      throw new Error('Invalid Collection cursor');
    return value;
  })
  .handler(async ({ data }) => {
    try {
      const authorization = await credential();
      return authorization ? await collections(kernelClient(data.locale), authorization, data.cursor) : denied;
    } catch (error) {
      return caught(error);
    }
  });
