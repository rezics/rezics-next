import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { readReleaseForCaller } from '../../subject/definitions';
import { readGuide, type GuideAddress, type GuideRead } from './definition-guide';

export function guideAddress(value: unknown): GuideAddress {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const result: GuideAddress = {};
  for (const key of ['type', 'property', 'release', 'returnTo'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || input[key].length > (key === 'returnTo' ? 2048 : 256))
        throw new Error('Invalid guide address');
      result[key] = input[key];
    }
  }
  return result;
}

export const readDefinitionGuide = createServerFn({ method: 'GET' })
  .validator(guideAddress)
  .handler(async ({ data }): Promise<GuideRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const request = getRequest();
      const stale = await prepareSession(request, env as Partial<SessionEnv>);
      if (stale) return { ok: false, reason: 'denied' };
      const authorization = viewerCredential(request);
      const headers = authorization ? { authorization } : {};
      const client = kernelClient();
      return readGuide(data, (digest) => readReleaseForCaller({ client, digest, headers }));
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  });
