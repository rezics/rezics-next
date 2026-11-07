import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import type { GuideFailure, GuideLocale } from './definition-guide';

export async function withGuideReader<T extends { ok: boolean }>(
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

export async function withCatalogueSession<T>(
  read: (input: { client: ReturnType<typeof kernelClient>; authorization: string }) => Promise<T>,
): Promise<T | { ok: false; reason: 'denied' | 'signed-out' | 'unavailable' }> {
  setResponseHeader('cache-control', 'private, no-store');
  try {
    const request = getRequest();
    const stale = await prepareSession(request, env as Partial<SessionEnv>);
    if (stale) return { ok: false, reason: 'denied' };
    const authorization = viewerCredential(request);
    if (!authorization) return { ok: false, reason: 'signed-out' };
    return await read({ client: kernelClient(), authorization });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
