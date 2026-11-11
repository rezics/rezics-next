import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { hasKernelOrigin, kernelClient } from '../../kernel/client';
import { recordPageReadCacheControl } from '../../security/page-cache';
import { m } from '../../paraglide/messages.js';
import type { SessionEnv } from '../../session/client';
import { carriesSession } from '../../session/csrf';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import { hostedBookVisitSchema } from './address';
import { createHostedCatalogueApi } from './native-api';
import { observeHostedBookVisit, type HostedBookVisit } from './visit';

/** Resolve public publication selections with the installed session, never a credential from a route operand. */
export const readHostedBookVisit = createServerFn({ method: 'GET' })
  .validator((value: unknown) => v.parse(hostedBookVisitSchema, value))
  .handler(async ({ data }): Promise<HostedBookVisit> => {
    const request = getRequest();
    setResponseHeader('cache-control', 'private, no-store');
    recordPageReadCacheControl(request, 'private, no-store');
    if (await prepareSession(request, env as Partial<SessionEnv>)) return { state: 'denied' };
    const authorization = viewerCredential(request);
    const subject = sessionSubject(request);
    if (carriesSession(request) && (!authorization || !subject)) return { state: 'unavailable' };
    if (authorization && !subject) return { state: 'denied' };
    if (!hasKernelOrigin()) return { state: 'unavailable' };
    return observeHostedBookVisit(
      createHostedCatalogueApi(kernelClient(data.locale, authorization ?? undefined), authorization, request.signal),
      data,
      subject ? { kind: 'session', subject } : { kind: 'anonymous' },
      m.book_reader_title({}, { locale: data.locale }),
    );
  });
