import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import {
  changeMembership,
  loadMyRealms,
  loadSpacePage,
  locateRealm,
  namePublishedTypes,
  type Located,
  type MembershipOutcome,
  type MyRealmsPage,
  type SpacePageData,
} from './space';

const idempotencyKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateAddress(input: unknown): { address: string } {
  if (
    !input ||
    typeof input !== 'object' ||
    !('address' in input) ||
    typeof input.address !== 'string' ||
    input.address.length === 0 ||
    input.address.length > 128
  )
    throw notFound();
  return { address: input.address };
}

function validateRealm(input: unknown): { realmId: string } {
  if (
    !input ||
    typeof input !== 'object' ||
    !('realmId' in input) ||
    typeof input.realmId !== 'string' ||
    input.realmId.length === 0 ||
    input.realmId.length > 128
  )
    throw notFound();
  return { realmId: input.realmId };
}

function validateCursor(input: unknown): { cursor?: string } {
  if (
    !input ||
    typeof input !== 'object' ||
    ('cursor' in input &&
      input.cursor !== undefined &&
      (typeof input.cursor !== 'string' || input.cursor.length > 4096))
  )
    throw new Error('Invalid Realms cursor');
  return 'cursor' in input && typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {};
}

function validateChange(input: unknown): { realmId: string; action: 'join' | 'leave'; idempotencyKey: string } {
  if (
    !input ||
    typeof input !== 'object' ||
    !('realmId' in input) ||
    typeof input.realmId !== 'string' ||
    input.realmId.length === 0 ||
    input.realmId.length > 128 ||
    !('action' in input) ||
    (input.action !== 'join' && input.action !== 'leave') ||
    !('idempotencyKey' in input) ||
    typeof input.idempotencyKey !== 'string' ||
    !idempotencyKeyPattern.test(input.idempotencyKey)
  )
    throw new Error('Invalid Realm membership request');
  return { realmId: input.realmId, action: input.action, idempotencyKey: input.idempotencyKey };
}

export const readSpacePage = createServerFn({ method: 'GET' })
  .validator(validateAddress)
  .handler(async ({ data }): Promise<SpacePageData> => {
    setResponseHeader('cache-control', 'private, no-store');
    const page = await loadSpacePage(kernelClient(), new Request('https://public.invalid/'), {}, data);
    return namePublishedTypes(page, requestLocale(getRequest()) ?? 'en');
  });

export const readPersonalSpacePage = createServerFn({ method: 'GET' })
  .validator(validateAddress)
  .handler(async ({ data }): Promise<SpacePageData> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const page = await loadSpacePage(kernelClient(), request, env as Partial<SessionEnv>, data);
    return namePublishedTypes(page, requestLocale(request) ?? 'en');
  });

export const locateRealmPage = createServerFn({ method: 'GET' })
  .validator(validateRealm)
  .handler(async ({ data }): Promise<Located> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const located = await locateRealm(kernelClient(), request, env as Partial<SessionEnv>, data);
    return located.kind === 'page'
      ? { ...located, page: await namePublishedTypes(located.page, requestLocale(request) ?? 'en') }
      : located;
  });

export const readMyRealmsPage = createServerFn({ method: 'GET' })
  .validator(validateCursor)
  .handler(async ({ data }): Promise<MyRealmsPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadMyRealms(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const changeRealmMembership = createServerFn({ method: 'POST' })
  .validator(validateChange)
  .handler(async ({ data }): Promise<{ outcome: MembershipOutcome }> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      return { outcome: await changeMembership(kernelClient(), getRequest(), env as Partial<SessionEnv>, data) };
    } catch {
      return { outcome: 'refused' };
    }
  });
