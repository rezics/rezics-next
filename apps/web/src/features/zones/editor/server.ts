import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { UI_LOCALES } from '@rezics/composition';
import { kernelClient } from '../../../kernel/client';
import type { SessionEnv } from '../../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../../session/request';
import { readRelease } from '../../../subject/definitions';
import { caught, collections, loadConfiguration, mutate, preview } from './api';
import {
  changeZoneLifecycle,
  type ZoneLifecycleClient,
  type ZoneLifecycleResult,
} from '../../catalogue/lifecycle-zone-commands.ts';
import {
  unavailable,
  validRevision,
  type LifecycleMutation,
  type LifecycleReading,
  type Loaded,
  type Mutation,
  type Result,
} from './model';
import type { OwnerReadObservation } from './owner-lifetime';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function input(value: { id: string; locale: string }) {
  if (!uuid.test(value.id) || !(UI_LOCALES as readonly string[]).includes(value.locale))
    throw new Error('Invalid Zone request');
  return value;
}
type OwnerRequest = { expectedReader?: string; admission?: string };
function ownerRequest(value: OwnerRequest): OwnerRequest {
  const hasReader = value.expectedReader !== undefined;
  const hasAdmission = value.admission !== undefined;
  if (
    hasReader !== hasAdmission ||
    (hasReader &&
      (typeof value.expectedReader !== 'string' || !value.expectedReader || value.expectedReader.length > 255)) ||
    (hasAdmission && (typeof value.admission !== 'string' || !/^\d+:\d+:[0-9a-f-]{36}$/.test(value.admission)))
  )
    throw new Error('Invalid Zone reader observation');
  return {
    ...(hasReader ? { expectedReader: value.expectedReader, admission: value.admission } : {}),
  };
}
function requestInput(value: { id: string; locale: string } & OwnerRequest) {
  return { ...input(value), ...ownerRequest(value) };
}
async function preparedReader(expected: OwnerRequest) {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  const stale = await prepareSession(request, env as Partial<SessionEnv>);
  const authorization = stale ? null : viewerCredential(request);
  const reader = stale ? undefined : sessionSubject(request);
  if (!authorization || (expected.expectedReader !== undefined && !reader)) return null;
  if (expected.expectedReader !== undefined && expected.expectedReader !== reader) return null;
  const ownerObservation: OwnerReadObservation | undefined =
    expected.expectedReader !== undefined && expected.admission !== undefined && reader !== undefined
      ? { reader, admission: expected.admission }
      : undefined;
  return { authorization, ownerObservation };
}
function observed<T extends object>(value: T, ownerObservation?: OwnerReadObservation): T {
  return ownerObservation ? { ...value, ownerObservation } : value;
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
  .validator(requestInput)
  .handler(async ({ data }): Promise<Loaded> => {
    let prepared: Awaited<ReturnType<typeof preparedReader>> | null = null;
    try {
      prepared = await preparedReader(data);
      if (!prepared) return noResource(denied);
      return observed(
        await loadConfiguration(kernelClient(data.locale), data.id, prepared.authorization, readRelease),
        prepared.ownerObservation,
      );
    } catch (error) {
      return observed(noResource(caught(error)), prepared?.ownerObservation);
    }
  });
const lifecycleStatus = {
  denied: 403,
  missing: 404,
  conflict: 412,
  invalid: 400,
  unavailable: 503,
} as const;
const lifecycleCode = {
  denied: 'forbidden',
  missing: 'not_found',
  conflict: 'precondition_failed',
  invalid: 'invalid_request',
  unavailable: 'dependency_unavailable',
} as const;
function lifecycleResult(result: ZoneLifecycleResult): Result<LifecycleReading> {
  if (result.ok)
    return {
      kind: 'ready',
      value: { revision: result.revision, deletedAt: result.deletedAt, restoreUntil: result.restoreUntil },
    };
  return { kind: 'failure', status: lifecycleStatus[result.reason], code: lifecycleCode[result.reason] };
}
export const writeLifecycle = createServerFn({ method: 'POST', strict: false })
  .validator((value: Omit<LifecycleMutation, 'csrf'> & { locale: string } & OwnerRequest) => {
    input(value);
    if (
      !validRevision(value.revision) ||
      !/^[0-9a-f-]{36}$/.test(value.key) ||
      (value.operation !== 'delete' && value.operation !== 'restore')
    )
      throw new Error('Invalid Zone lifecycle');
    return { ...value, ...ownerRequest(value) };
  })
  .handler(async ({ data }): Promise<Result<LifecycleReading>> => {
    let prepared: Awaited<ReturnType<typeof preparedReader>> | null = null;
    try {
      prepared = await preparedReader(data);
      if (!prepared) return denied;
      return observed(
        lifecycleResult(
          await changeZoneLifecycle(
            kernelClient(data.locale) as unknown as ZoneLifecycleClient,
            prepared.authorization,
            {
              id: data.id,
              revision: data.revision,
              key: data.key,
              operation: data.operation,
            },
          ),
        ),
        prepared.ownerObservation,
      );
    } catch (error) {
      return observed(caught(error), prepared?.ownerObservation);
    }
  });
export const writeConfiguration = createServerFn({ method: 'POST' })
  .validator((value: Mutation & { locale: string } & OwnerRequest) => {
    input(value);
    if (
      !validRevision(value.revision) ||
      !/^[0-9a-f-]{36}$/.test(value.key) ||
      !['save', 'publish'].includes(value.operation)
    )
      throw new Error('Invalid Zone mutation');
    return { ...value, ...ownerRequest(value) };
  })
  .handler(async ({ data }) => {
    let prepared: Awaited<ReturnType<typeof preparedReader>> | null = null;
    try {
      prepared = await preparedReader(data);
      return prepared
        ? observed(await mutate(kernelClient(data.locale), prepared.authorization, data), prepared.ownerObservation)
        : denied;
    } catch (error) {
      return observed(caught(error), prepared?.ownerObservation);
    }
  });
export const readSavedPreview = createServerFn({ method: 'GET', strict: false })
  .validator((value: { id: string; locale: string; route: string } & OwnerRequest) => {
    requestInput(value);
    if (typeof value.route !== 'string' || value.route.length > 255) throw new Error('Invalid Zone route');
    return { ...value, ...ownerRequest(value) };
  })
  .handler(async ({ data }) => {
    let prepared: Awaited<ReturnType<typeof preparedReader>> | null = null;
    try {
      prepared = await preparedReader(data);
      return prepared
        ? observed(
            await preview(kernelClient(data.locale), prepared.authorization, data.id, data.route, data.locale),
            prepared.ownerObservation,
          )
        : denied;
    } catch (error) {
      return observed(caught(error), prepared?.ownerObservation);
    }
  });
export const readMountChoices = createServerFn({ method: 'GET' })
  .validator((value: { locale: string; cursor: string } & OwnerRequest) => {
    if (
      !(UI_LOCALES as readonly string[]).includes(value.locale) ||
      typeof value.cursor !== 'string' ||
      value.cursor.length > 8192
    )
      throw new Error('Invalid Collection cursor');
    return { ...value, ...ownerRequest(value) };
  })
  .handler(async ({ data }) => {
    let prepared: Awaited<ReturnType<typeof preparedReader>> | null = null;
    try {
      prepared = await preparedReader(data);
      return prepared
        ? observed(
            await collections(kernelClient(data.locale), prepared.authorization, data.cursor),
            prepared.ownerObservation,
          )
        : denied;
    } catch (error) {
      return observed(caught(error), prepared?.ownerObservation);
    }
  });
