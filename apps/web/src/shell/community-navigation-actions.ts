import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient, requestLocale } from '../kernel/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import type { SessionEnv } from '../session/client';
import { loadShellCommunities, type ShellCommunities } from './community-navigation';

export const readShellCommunities = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ShellCommunities | null> => {
    setResponseHeader('cache-control', 'private, no-store');
    const { env } = await import('cloudflare:workers');
    const request = getRequest();
    if (await prepareSession(request, env as Partial<SessionEnv>)) return null;
    const subject = sessionSubject(request);
    const authorization = viewerCredential(request);
    if (!subject || !authorization) return null;
    return {
      subject,
      locale: requestLocale(request) ?? 'en',
      ...(await loadShellCommunities(kernelClient(), authorization)),
    };
  },
);
