import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import { recordPageReadCacheControl } from '../../security/page-cache';
import {
  commandExposure,
  loadExposure,
  parseIntent,
  parseExposureQuery,
  object,
  type ExposureReaderEnvelope,
  type Outcome,
  type Page,
} from './data';

async function prepareViewerRequest() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  recordPageReadCacheControl(request, 'private, no-store');
  // Shared middleware validates the current session, Origin and session-bound CSRF for unsafe calls.
  await prepareSession(request, env as Partial<SessionEnv>);
  return request;
}
async function viewer() {
  return viewerCredential(await prepareViewerRequest());
}
const configured = () => Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN);

export const readPlatformExposure = createServerFn({ method: 'GET' })
  .validator(parseExposureQuery)
  .handler(async ({ data }): Promise<Page> => {
    const authorization = await viewer();
    if (!authorization) return { status: 'signed-out', discovery: { status: 'unavailable' } };
    if (!configured()) return { status: 'unavailable', discovery: { status: 'unavailable' } };
    return loadExposure(kernelClient(), authorization, data);
  });

/** Production-only read binding. The subject is captured from the request that supplied this credential. */
export const readPlatformExposureBound = createServerFn({ method: 'GET' })
  .validator(parseExposureQuery)
  .handler(async ({ data }): Promise<ExposureReaderEnvelope> => {
    const request = await prepareViewerRequest();
    const authorization = viewerCredential(request);
    const actualSubject = sessionSubject(request) ?? null;
    if (!authorization)
      return { page: { status: 'signed-out', discovery: { status: 'unavailable' } }, sessionSubject: actualSubject };
    if (!configured())
      return { page: { status: 'unavailable', discovery: { status: 'unavailable' } }, sessionSubject: actualSubject };
    return { page: await loadExposure(kernelClient(), authorization, data), sessionSubject: actualSubject };
  });
export const changePlatformExposure = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!object(value) || Object.keys(value).length !== 2 || !('operation' in value) || !('query' in value))
      throw new Error('Invalid exposure command selection');
    return { operation: parseIntent(value.operation), query: parseExposureQuery(value.query) };
  })
  .handler(async ({ data }): Promise<Outcome> => {
    const authorization = await viewer();
    if (!authorization)
      return { status: 'not-sent', current: { status: 'signed-out', discovery: { status: 'unavailable' } } };
    if (!configured())
      return { status: 'not-sent', current: { status: 'unavailable', discovery: { status: 'unavailable' } } };
    return commandExposure(kernelClient(), authorization, data.operation, data.query);
  });
