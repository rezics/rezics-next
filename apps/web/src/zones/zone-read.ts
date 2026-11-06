import type { KernelClient } from '@rezics/client';
import { isView, type View } from '@rezics/composition';
import { notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader, setResponseStatus } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { ReadCredentialMode } from '../kernel/credential';
import type { SessionEnv } from '../session/client';
import { loadSubjectPage, type SubjectPageData } from '../features/pages/subject';
import { loadViewPages } from '../features/pages/subject-frame';
import { locales } from '../paraglide/runtime.js';
import type { ZonePageQuery, ZonePageReadProgress, ZonePageRequest, ZonePageResponse } from './appearance.ts';
import { isolatePublicZonePage, receiveZonePage, type ReceivedZonePage } from './receive.ts';
import { nextKernelSession, zoneKernelHeaders } from './session.ts';
import { applyZoneTransport, zoneRequestTransport, zoneTransportHeaders } from './transport.ts';
import { validZoneCursor } from './visit.ts';

export { zoneConfiguredRoute, zoneLocationSearch, zonePageSearch } from './visit';

export { isZoneSubjectId, zoneReturnHref, zoneRouteHref, zoneSubjectHref } from './destinations.ts';

type ZoneRouteClient = {
  zones(input: { id: string }): {
    $readPage: {
      post(
        body: ZonePageRequest,
        options?: { query?: ZonePageQuery; headers?: { authorization?: string; [header: string]: string | undefined } },
      ): Promise<{
        status: number;
        data: ZonePageResponse | ZonePageReadProgress | null;
        error?: { value?: unknown } | null;
        response: Response;
      }>;
    };
  };
};

export type ZonePageOutcome =
  | { kind: 'page'; page: ReceivedZonePage }
  | { kind: 'preparing'; cursor?: string; retryAfter: string }
  | { kind: 'unavailable'; retryAfter: string }
  | { kind: 'missing' }
  | { kind: 'error' };

export type ZonePageRouteOutcome =
  | {
      kind: 'page';
      page: ReceivedZonePage;
      common?: {
        page: SubjectPageData;
        overview: SubjectPageData;
        view: View;
        frame?: import('../features/pages/subject-frame').SubjectFrameData;
        tabs?: readonly import('../features/pages/views').ViewTab[];
        type?: { label?: string; ratio?: import('@rezics/ui/cover').CoverRatio };
        relations?: Record<string, import('../subject/relations').RelationDefinition>;
      };
    }
  | { kind: 'preparing'; cursor?: string; retryAfter: string }
  | { kind: 'unavailable'; retryAfter: string }
  | { kind: 'missing' }
  | { kind: 'redirect'; id: string }
  | { kind: 'error' };

export type ZonePageInput = {
  id: string;
  locale: string;
  target: ZonePageRequest['target'];
  cursor?: ZonePageQuery['cursor'];
  credentialMode?: ReadCredentialMode;
};

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validTarget(value: unknown): value is ZonePageRequest['target'] {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === 'route' && typeof value.route === 'string') return value.route.length <= 255;
  if (
    (keys.length === 1 || keys.length === 2) &&
    keys.includes('subject') &&
    (keys.length === 1 || keys.includes('view')) &&
    typeof value.subject === 'string' &&
    idPattern.test(value.subject) &&
    (keys.length === 1 || isView(value.view))
  )
    return true;
  return false;
}

export function validateZonePageInput(input: unknown): ZonePageInput {
  const allowedKeys = new Set(['id', 'locale', 'target', 'cursor', 'credentialMode']);
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !allowedKeys.has(key)) ||
    typeof input.id !== 'string' ||
    !idPattern.test(input.id) ||
    typeof input.locale !== 'string' ||
    !locales.includes(input.locale as (typeof locales)[number]) ||
    !validTarget(input.target) ||
    ('cursor' in input && input.cursor !== undefined && !validCursor(input.cursor)) ||
    ('credentialMode' in input &&
      input.credentialMode !== undefined &&
      input.credentialMode !== 'anonymous' &&
      input.credentialMode !== 'session')
  )
    throw notFound();
  return {
    id: input.id,
    locale: input.locale,
    target: input.target,
    ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
    ...(input.credentialMode === 'session' ? { credentialMode: 'session' } : {}),
  };
}

function validCursor(value: unknown): value is string {
  return validZoneCursor(value);
}

function retryAfter(response: Response): string {
  return response.headers.get('retry-after') ?? '1';
}

function problemCode(result: { data: unknown; error?: { value?: unknown } | null }): string | undefined {
  const body = result.error?.value ?? result.data;
  return isRecord(body) && typeof body.code === 'string' ? body.code : undefined;
}

/** Read the typed Zone page operation through the generated Eden client, following at most four continuations. */
export async function readZonePage(
  client: KernelClient,
  id: string,
  request: ZonePageRequest,
  options: {
    cursor?: ZonePageQuery['cursor'];
    followContinuations?: boolean;
    authorization?: string;
    kernelSession?: string;
    session?: boolean;
  } = {},
): Promise<ZonePageOutcome> {
  const zone = (client as unknown as ZoneRouteClient).zones({ id });
  let cursor = options.cursor;
  let kernelSession = options.kernelSession;
  let restarted = false;
  const follow = options.followContinuations !== false;
  for (let follows = 0; ;) {
    let result: Awaited<ReturnType<typeof zone.$readPage.post>>;
    try {
      const binding = {
        ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
        ...(kernelSession === undefined ? {} : { kernelSession }),
      };
      const headers = zoneKernelHeaders(binding);
      const call: {
        query?: ZonePageQuery;
        headers?: NonNullable<ReturnType<typeof zoneKernelHeaders>>;
      } = {};
      if (cursor !== undefined) call.query = { cursor };
      if (headers !== undefined) call.headers = headers;
      result = await zone.$readPage.post(request, call);
    } catch {
      return { kind: 'error' };
    }
    kernelSession = nextKernelSession(result.response, kernelSession);
    if (result.status === 404 || result.status === 401) return { kind: 'missing' };
    if (result.status === 200 && result.data) {
      const received = receiveZonePage(result.data);
      if (!received) return { kind: 'error' };
      return {
        kind: 'page',
        page: isolatePublicZonePage(received, options.session === true && options.authorization !== undefined),
      };
    }
    if (result.status === 503) return { kind: 'unavailable', retryAfter: retryAfter(result.response) };
    if (result.status === 409 && problemCode(result) === 'stale_cursor' && cursor !== undefined && !restarted) {
      restarted = true;
      cursor = undefined;
      continue;
    }
    if (result.status !== 202 || !result.data || !validCursor((result.data as ZonePageReadProgress).next))
      return { kind: 'error' };
    cursor = (result.data as ZonePageReadProgress).next;
    if (!follow || follows === 4) return { kind: 'preparing', cursor, retryAfter: retryAfter(result.response) };
    follows++;
  }
}

/** The Zone page is authoritative; common subject reads supply the existing frame and view context. */
export async function readZonePageForRoute(
  client: KernelClient,
  input: ZonePageInput,
  options: {
    followContinuations?: boolean;
    authorization?: string;
    kernelSession?: string;
  } = {},
): Promise<ZonePageRouteOutcome> {
  const result = await readZonePage(
    client,
    input.id,
    { target: input.target, languages: [input.locale] },
    {
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(options.followContinuations === undefined ? {} : { followContinuations: options.followContinuations }),
      ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
      ...(options.kernelSession === undefined ? {} : { kernelSession: options.kernelSession }),
      session: input.credentialMode === 'session',
    },
  );
  if (result.kind !== 'page' || !('subject' in input.target)) return result;

  const view = input.target.view;
  if (view && view !== 'overview') {
    const loaded = await loadViewPages(client, input.target.subject, view);
    if (loaded.kind !== 'page') return loaded;
    return { ...result, common: { page: loaded.page, overview: loaded.overview, view } };
  }

  const loaded = await loadSubjectPage(client, input.target.subject, view as View | undefined);
  if (loaded.kind !== 'page') return loaded;
  return { ...result, common: { page: loaded.page, overview: loaded.page, view: 'overview' as const } };
}

function setReadResponse(outcome: ZonePageRouteOutcome, serverRender: boolean): void {
  if (outcome.kind === 'preparing') {
    setResponseHeader('cache-control', 'no-store');
    setResponseHeader('retry-after', outcome.retryAfter);
    if (serverRender) setResponseStatus(503, 'Service Unavailable');
    return;
  }
  if (outcome.kind === 'unavailable') {
    setResponseHeader('cache-control', 'no-store');
    setResponseHeader('retry-after', outcome.retryAfter);
    setResponseStatus(503, 'Service Unavailable');
    return;
  }
  if (outcome.kind === 'missing' || outcome.kind === 'error') setResponseHeader('cache-control', 'no-store');
}

async function readForRequest(input: ZonePageInput, followContinuations: boolean): Promise<ZonePageRouteOutcome> {
  const { kernelClient } = await import('../kernel/client');
  const request = getRequest();
  const transport = applyZoneTransport(
    await zoneRequestTransport(request, env as Partial<SessionEnv>, input.credentialMode),
  );
  const headers = zoneTransportHeaders(transport);
  let outcome = await readZonePageForRoute(kernelClient(input.locale), input, {
    followContinuations,
    ...(headers?.authorization === undefined ? {} : { authorization: headers.authorization }),
    ...(transport.kernelSession === undefined ? {} : { kernelSession: transport.kernelSession }),
  });
  if (outcome.kind === 'page' && outcome.common) {
    const { page, overview, view } = outcome.common;
    const { pageRelationProperties, subjectPageType } = await import('../features/pages/subject');
    const { subjectFrame } = await import('../features/pages/subject-frame');
    const { subjectTabs } = await import('../features/pages/views');
    const { relationLabels, typeFrame } = await import('../subject/definitions');
    const type = subjectPageType(overview);
    const [frame, typeDetails, relations] = await Promise.all([
      view === 'overview' ? Promise.resolve(undefined) : Promise.resolve(subjectFrame(overview, input.locale)),
      type ? typeFrame(type, input.locale) : Promise.resolve({}),
      relationLabels(pageRelationProperties(outcome.page as unknown as SubjectPageData), input.locale),
    ]);
    if (view !== 'overview' && !frame) outcome = { kind: 'missing' };
    else
      outcome = {
        ...outcome,
        common: {
          page,
          overview,
          view,
          ...(frame ? { frame } : {}),
          tabs: subjectTabs(overview),
          type: typeDetails,
          relations,
        },
      };
  }
  setReadResponse(outcome, followContinuations);
  return outcome;
}

export const readZonePageRequest = createServerFn({ method: 'GET', strict: false })
  .validator(validateZonePageInput)
  .handler(async ({ data }) => {
    const outcome = await readForRequest(data, true);
    if (outcome.kind === 'missing') throw notFound();
    if (outcome.kind === 'redirect')
      throw redirect({ href: `/${data.locale}/subjects/${outcome.id}`, statusCode: 308 });
    if (outcome.kind === 'error') throw new Error('The Zone page could not be read.');
    return outcome;
  });

export const continueZonePageRequest = createServerFn({ method: 'GET', strict: false })
  .validator(validateZonePageInput)
  .handler(async ({ data }) => {
    const outcome = await readForRequest(data, false);
    if (outcome.kind === 'redirect')
      throw redirect({ href: `/${data.locale}/subjects/${outcome.id}`, statusCode: 308 });
    return outcome;
  });
