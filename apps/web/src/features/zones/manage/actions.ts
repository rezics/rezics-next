import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../../kernel/client';
import type { SessionEnv } from '../../../session/client';
import { listInput, type CreateCommand, type LifecycleCommand } from './model';
import { changeOwnedZone, createOwnedZone, readOwnedZones } from './request';
import type { OwnerReadObservation } from '../editor/owner-lifetime';

type OwnerRequest = { expectedReader?: string; admission?: string };
function ownerObservation(value: OwnerRequest | null | undefined): OwnerReadObservation | undefined {
  if (!value) return undefined;
  const hasReader = value.expectedReader !== undefined;
  const hasAdmission = value.admission !== undefined;
  if (
    hasReader !== hasAdmission ||
    (hasReader &&
      (typeof value.expectedReader !== 'string' || !value.expectedReader || value.expectedReader.length > 255)) ||
    (hasAdmission && (typeof value.admission !== 'string' || !/^\d+:\d+:[0-9a-f-]{36}$/.test(value.admission)))
  )
    throw new Error('Invalid Zone reader observation');
  return hasReader ? { reader: value.expectedReader!, admission: value.admission! } : undefined;
}
function ownerFields(value: OwnerRequest | null | undefined) {
  const observation = ownerObservation(value);
  return observation ? { expectedReader: observation.reader, admission: observation.admission } : {};
}

export const readMyZones = createServerFn({ method: 'GET' })
  .validator((input: Record<string, unknown>) => ({
    ...listInput(input),
    ...ownerFields(input as OwnerRequest),
  }))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return readOwnedZones(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      { deleted: data.deleted, ...(data.cursor ? { cursor: data.cursor } : {}) },
      ownerObservation(data),
    );
  });

export const changeMyZone = createServerFn({ method: 'POST', strict: false })
  .validator((input: LifecycleCommand & OwnerRequest) => ({
    id: input?.id,
    revision: input?.revision,
    key: input?.key,
    operation: input?.operation,
    ...ownerFields(input),
  }))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return changeOwnedZone(kernelClient(), getRequest(), env as Partial<SessionEnv>, data, ownerObservation(data));
  });

export const createMyZone = createServerFn({ method: 'POST', strict: false })
  .validator((input: CreateCommand & OwnerRequest) => ({
    starter: input?.starter,
    key: input?.key,
    labels: input?.labels,
    ...(input?.primaryLanguage === undefined ? {} : { primaryLanguage: input.primaryLanguage }),
    ...ownerFields(input),
  }))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return createOwnedZone(kernelClient(), getRequest(), env as Partial<SessionEnv>, data, ownerObservation(data));
  });
