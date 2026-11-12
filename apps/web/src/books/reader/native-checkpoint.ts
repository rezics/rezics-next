import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { hasKernelOrigin, kernelClient } from '../../kernel/client';
import { recordPageReadCacheControl } from '../../security/page-cache';
import type { SessionEnv } from '../../session/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../../session/request';
import { locales } from '../../paraglide/runtime.js';
import { hostedId, type HostedRead } from './native-api';
import {
  checkpointCommandSchema,
  readHostedCheckpoint,
  writeHostedCheckpoint,
  type CheckpointView,
  type CheckpointWrite,
} from './checkpoint-api';

const context = { locale: v.picklist(locales), viewer: hostedId };
const readSchema = v.strictObject({ ...context, subjectId: hostedId });
const writeSchema = v.strictObject({ ...context, command: checkpointCommandSchema, key: v.pipe(v.string(), v.uuid()) });
export type CheckpointObservation = HostedRead<CheckpointView> & { csrfToken?: string | null };

async function prepare(viewer: string) {
  const request = getRequest();
  setResponseHeader('cache-control', 'private, no-store');
  recordPageReadCacheControl(request, 'private, no-store');
  if (await prepareSession(request, env as Partial<SessionEnv>)) return null;
  const authorization = viewerCredential(request);
  if (!authorization || sessionSubject(request) !== viewer || !hasKernelOrigin()) return null;
  return { request, authorization, csrfToken: requestCsrfToken(request) };
}

export const readNativeHostedCheckpoint = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(readSchema, input))
  .handler(async ({ data }): Promise<CheckpointObservation> => {
    const session = await prepare(data.viewer);
    if (!session) return { state: 'denied' };
    const result = await readHostedCheckpoint(
      kernelClient(data.locale, session.authorization),
      session.authorization,
      data.subjectId,
      session.request.signal,
    );
    return { ...result, csrfToken: session.csrfToken };
  });

export const writeNativeHostedCheckpoint = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(writeSchema, input))
  .handler(async ({ data }): Promise<CheckpointWrite> => {
    const session = await prepare(data.viewer);
    if (!session) return { state: 'denied' };
    return writeHostedCheckpoint(
      kernelClient(data.locale, session.authorization),
      session.authorization,
      data.command,
      data.key,
      session.request.signal,
    );
  });
