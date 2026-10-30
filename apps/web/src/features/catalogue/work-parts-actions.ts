import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import { prepareSession, viewerCredential } from '../../session/request';
import type { SessionEnv } from '../../session/client';
import { fetchGuideRelease } from './definition-guide';
import { readWorkParts, type WorkPartsRead } from './work-parts';

export const readSubjectWorkParts = createServerFn({ method: 'POST', strict: false })
  .validator(
    (input: { id: string; stream?: string | undefined; cursor?: string | undefined; session?: string | undefined }) => {
      if (
        !input ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id) ||
        (input.stream !== undefined && (typeof input.stream !== 'string' || input.stream.length > 256)) ||
        (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 8192)) ||
        (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384))
      )
        throw new Error('Invalid work parts address');
      return { id: input.id, stream: input.stream, cursor: input.cursor, session: input.session };
    },
  )
  .handler(async ({ data }): Promise<WorkPartsRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) return { ok: false, reason: 'denied' };
    const client = kernelClient();
    return readWorkParts(
      client,
      authorization,
      fetchGuideRelease(client, undefined, { authorization }),
      data.id,
      requestLocale() ?? 'en',
      data.stream,
      data.cursor,
      data.session,
    );
  });
