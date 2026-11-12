import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import * as v from 'valibot';
import type { KernelClient } from '@rezics/client';
import { locales } from '../paraglide/runtime.js';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import {
  hostedCheckpointCursorSchema,
  hostedCheckpointViewerSchema,
  readHostedCheckpointPage,
  type HostedCheckpointResult,
  type HostedCheckpointRequest,
  type HostedCheckpointTransport,
} from './hosted-checkpoint-source';

const input = v.strictObject({
  viewer: hostedCheckpointViewerSchema,
  locale: v.picklist(locales),
  cursor: v.exactOptional(hostedCheckpointCursorSchema),
});

/** Owner-private BFF only. Entry progress keeps its existing endpoint and independent cursor. */
export const readLibraryHostedCheckpoints = createServerFn({ method: 'GET' })
  .validator((value: unknown) => v.parse(input, value))
  .handler(async ({ data }): Promise<HostedCheckpointResult> => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const request = getRequest();
    const { env } = await import('cloudflare:workers');
    const { hasKernelOrigin, kernelClient } = await import('../kernel/client');
    return loadHostedCheckpointState(request, env as Partial<SessionEnv>, data, (authorization) =>
      hasKernelOrigin() ? kernelClient(data.locale, authorization) : null,
    );
  });

/** Prepare once, before connecting or disclosing any checkpoint data to a claimed viewer. */
export async function loadHostedCheckpointState(
  request: Request,
  env: Partial<SessionEnv>,
  data: HostedCheckpointRequest,
  connect: (authorization: string) => KernelClient | null,
  transport?: HostedCheckpointTransport,
): Promise<HostedCheckpointResult> {
  if (await prepareSession(request, env, { refresh: false })) return { state: 'signed-out' };
  const authorization = viewerCredential(request);
  if (!authorization) return { state: 'signed-out' };
  if (sessionSubject(request) !== data.viewer) return { state: 'denied' };
  const client = connect(authorization);
  if (!client) return { state: 'unavailable' };
  return readHostedCheckpointPage(client, authorization, data, request.signal, transport);
}
