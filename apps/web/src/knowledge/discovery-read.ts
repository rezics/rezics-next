import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import { recordPageReadCacheControl } from '../security/page-cache';
import { isSessionUnavailableError } from '../session/unavailable';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { parseKnowledgeDiscoveryRequest, readKnowledgeDiscovery, type KnowledgeDiscoveryRead } from './discovery';

async function currentAuthorization(): Promise<string | undefined> {
  const request = getRequest();
  try {
    await prepareSession(request, env as Partial<SessionEnv>);
  } catch (error) {
    if (isSessionUnavailableError(error)) return undefined;
    throw error;
  }
  return viewerCredential(request) ?? undefined;
}

/** One bounded native page through the existing Web transport. Anonymous when no current session exists. */
export const readKnowledgeDiscoveryPage = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const request = parseKnowledgeDiscoveryRequest(input);
    if (!request) throw new Error('invalid_knowledge_discovery_request');
    return request;
  })
  .handler(async ({ data }): Promise<KnowledgeDiscoveryRead> => {
    const http = getRequest();
    setResponseHeader('cache-control', 'private, no-store');
    recordPageReadCacheControl(http, 'private, no-store');
    return readKnowledgeDiscovery(kernelClient(data.locale), data, await currentAuthorization());
  });
