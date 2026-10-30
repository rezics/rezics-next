import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { UI_LOCALES } from '@rezics/composition';
import { kernelClient } from '../../../kernel/client';
import type { SessionEnv } from '../../../session/client';
import { listInput, type CreateCommand, type LifecycleCommand } from './model';
import { changeOwnedZone, createOwnedZone, readOwnedZones } from './request';

export const readMyZones = createServerFn({ method: 'GET' })
  .validator((input: Record<string, unknown>) => listInput(input))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return readOwnedZones(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const changeMyZone = createServerFn({ method: 'POST', strict: false })
  .validator((input: LifecycleCommand): LifecycleCommand => ({
    id: input?.id,
    revision: input?.revision,
    key: input?.key,
    operation: input?.operation,
  }))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return changeOwnedZone(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const createMyZone = createServerFn({ method: 'POST', strict: false })
  .validator((input: CreateCommand): CreateCommand => ({
    starter: input?.starter,
    key: input?.key,
    labels: Object.fromEntries(
      UI_LOCALES.map((locale) => [locale, input?.labels?.[locale]]),
    ) as CreateCommand['labels'],
  }))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return createOwnedZone(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
