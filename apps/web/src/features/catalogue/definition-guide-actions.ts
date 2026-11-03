import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { readReleaseForCaller } from '../../subject/definitions';
import {
  fetchGuideActiveDigest,
  guideLocales,
  guideIdentifierLimit,
  readGuide,
  readGuideDirectory,
  readGuideType,
  type GuideAddress,
  type GuideFailure,
  type GuideLocale,
  type GuidePageRead,
  type GuideRead,
  type GuideTypeRead,
} from './definition-guide';
import { guideCompareValue } from './definition-guide-comparison';

export function guideAddress(value: unknown): GuideAddress {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const result: GuideAddress = {};
  for (const key of ['type', 'property', 'release', 'returnTo', 'compare'] as const) {
    if (input[key] !== undefined) {
      const limit =
        key === 'returnTo' ? 2048 : key === 'compare' ? 32 : key === 'type' || key === 'property' ? guideIdentifierLimit : 256;
      if (typeof input[key] !== 'string' || input[key].length > limit) throw new Error('Invalid guide address');
      if (key === 'compare') {
        if (input[key] === guideCompareValue) result.compare = guideCompareValue;
        continue;
      }
      result[key] = input[key];
    }
  }
  return result;
}

function requestObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid guide request');
  return value as Record<string, unknown>;
}

function locale(value: unknown): GuideLocale {
  if (typeof value !== 'string' || !guideLocales.includes(value as GuideLocale))
    throw new Error('Invalid guide locale');
  return value as GuideLocale;
}

export function guideReadRequest(value: unknown): { address: GuideAddress; locale: GuideLocale } {
  const input = requestObject(value);
  return { address: guideAddress(input.address), locale: locale(input.locale) };
}

export function guideDirectoryRequest(value: unknown): { query: string; cursor?: string; locale: GuideLocale } {
  const input = requestObject(value);
  if (typeof input.query !== 'string' || input.query.length > 512) throw new Error('Invalid guide search');
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 4096))
    throw new Error('Invalid guide cursor');
  return {
    query: input.query,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor as string }),
    locale: locale(input.locale),
  };
}

export function guideTypeRequest(value: unknown): { typeId: string; locale: GuideLocale } {
  const input = requestObject(value);
  if (typeof input.typeId !== 'string' || input.typeId.length === 0 || input.typeId.length > guideIdentifierLimit)
    throw new Error('Invalid Type ID');
  return { typeId: input.typeId, locale: locale(input.locale) };
}

async function withGuideReader<T extends { ok: boolean }>(
  selectedLocale: GuideLocale,
  read: (options: { client: ReturnType<typeof kernelClient>; headers: Record<string, string> }) => Promise<T>,
): Promise<T | { ok: false; reason: GuideFailure }> {
  setResponseHeader('cache-control', 'private, no-store');
  try {
    const request = getRequest();
    const stale = await prepareSession(request, env as Partial<SessionEnv>);
    if (stale) return { ok: false, reason: 'denied' };
    const authorization = viewerCredential(request);
    const headers = authorization ? { authorization } : {};
    return await read({ client: kernelClient(selectedLocale), headers });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export const readDefinitionGuide = createServerFn({ method: 'GET' })
  .validator(guideReadRequest)
  .handler(async ({ data }): Promise<GuideRead> =>
    withGuideReader(data.locale, ({ client, headers }) =>
      readGuide(
        data.address,
        (digest) => readReleaseForCaller({ client, ...(digest ? { digest } : {}), headers }),
        () => readGuideDirectory(client, data.locale, '', undefined, headers),
        (typeId) => readGuideType(client, typeId, data.locale, headers),
        () => fetchGuideActiveDigest(client, headers),
      ),
    ),
  );

export const readDefinitionGuideDirectory = createServerFn({ method: 'GET' })
  .validator(guideDirectoryRequest)
  .handler(async ({ data }): Promise<GuidePageRead> =>
    withGuideReader(data.locale, ({ client, headers }) =>
      readGuideDirectory(client, data.locale, data.query, data.cursor, headers),
    ),
  );

export const readDefinitionGuideType = createServerFn({ method: 'GET' })
  .validator(guideTypeRequest)
  .handler(async ({ data }): Promise<GuideTypeRead> =>
    withGuideReader(data.locale, ({ client, headers }) => readGuideType(client, data.typeId, data.locale, headers)),
  );
