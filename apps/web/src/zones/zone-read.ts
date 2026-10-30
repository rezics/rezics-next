import type { KernelClient } from '@rezics/client';
import type { View } from '@rezics/composition';
import { notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader, setResponseStatus } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { ZonePageRequest, ZonePageResponse } from '../../../../services/kernel/src/zones/contract.ts';
import type { ZonePageQuery, ZonePageReadProgress } from '../../../../services/kernel/src/zones/page-continuation.ts';
import type { ReadCredentialMode } from '../kernel/credential';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { loadSubjectPage, type SubjectPageData } from '../features/pages/subject';
import { loadViewPages } from '../features/pages/subject-frame';
import { locales } from '../paraglide/runtime.js';

type ZoneRouteClient = {
  zones(input: { id: string }): {
    $readPage: {
      post(
        body: ZonePageRequest,
        options?: { query?: ZonePageQuery; headers?: { authorization: string } },
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
  | { kind: 'page'; page: ZonePageResponse }
  | { kind: 'preparing'; cursor?: string; retryAfter: string }
  | { kind: 'unavailable'; retryAfter: string }
  | { kind: 'missing' }
  | { kind: 'error' };

export type ZonePageRouteOutcome =
  | {
      kind: 'page';
      page: ZonePageResponse;
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

function validTarget(value: unknown): value is Extract<ZonePageRequest['target'], { route: string }> {
  return (
    isRecord(value) && Object.keys(value).length === 1 && typeof value.route === 'string' && value.route.length <= 255
  );
}

function validateInput(input: unknown): ZonePageInput {
  if (
    !isRecord(input) ||
    typeof input.id !== 'string' ||
    !idPattern.test(input.id) ||
    typeof input.locale !== 'string' ||
    !locales.includes(input.locale as (typeof locales)[number]) ||
    !validTarget(input.target) ||
    ('cursor' in input && input.cursor !== undefined && typeof input.cursor !== 'string') ||
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

function retryAfter(response: Response): string {
  return response.headers.get('retry-after') ?? '1';
}

/** Read the typed Zone page operation through the generated Eden client, following at most four continuations. */
export async function readZonePage(
  client: KernelClient,
  id: string,
  request: ZonePageRequest,
  options: { cursor?: ZonePageQuery['cursor']; followContinuations?: boolean; authorization?: string } = {},
): Promise<ZonePageOutcome> {
  const zone = (client as unknown as ZoneRouteClient).zones({ id });
  let cursor = options.cursor;
  const follow = options.followContinuations !== false;
  for (let attempt = 0; attempt <= (follow ? 4 : 0); attempt++) {
    let result: Awaited<ReturnType<typeof zone.$readPage.post>>;
    try {
      result = await zone.$readPage.post(request, {
        ...(cursor === undefined ? {} : { query: { cursor } }),
        ...(options.authorization ? { headers: { authorization: options.authorization } } : {}),
      });
    } catch {
      return { kind: 'error' };
    }
    if (result.status === 404) return { kind: 'missing' };
    if (result.status === 200 && result.data) return { kind: 'page', page: result.data as ZonePageResponse };
    if (result.status === 503) return { kind: 'unavailable', retryAfter: retryAfter(result.response) };
    if (result.status !== 202 || !result.data || typeof (result.data as ZonePageReadProgress).next !== 'string')
      return { kind: 'error' };
    cursor = (result.data as ZonePageReadProgress).next;
    if (!follow || attempt === 4) return { kind: 'preparing', cursor, retryAfter: retryAfter(result.response) };
  }
  return { kind: 'error' };
}

/** The Zone page is authoritative; common subject reads supply the existing frame and view context. */
export async function readZonePageForRoute(
  client: KernelClient,
  input: ZonePageInput,
  options: { followContinuations?: boolean; authorization?: string } = {},
): Promise<ZonePageRouteOutcome> {
  const result = await readZonePage(
    client,
    input.id,
    { target: input.target, languages: [input.locale] },
    {
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(options.followContinuations === undefined ? {} : { followContinuations: options.followContinuations }),
      ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
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
  let authorization: string | undefined;
  if (input.credentialMode === 'session') {
    await prepareSession(request, env as Partial<SessionEnv>);
    authorization = viewerCredential(request) ?? undefined;
  }
  setResponseHeader('cache-control', 'private, no-store');
  let outcome = await readZonePageForRoute(kernelClient(input.locale), input, {
    followContinuations,
    ...(authorization === undefined ? {} : { authorization }),
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
  .validator(validateInput)
  .handler(async ({ data }) => {
    const outcome = await readForRequest(data, true);
    if (outcome.kind === 'missing') throw notFound();
    if (outcome.kind === 'redirect')
      throw redirect({ href: `/${data.locale}/subjects/${outcome.id}`, statusCode: 308 });
    if (outcome.kind === 'error') throw new Error('The Zone page could not be read.');
    return outcome;
  });

export const continueZonePageRequest = createServerFn({ method: 'GET', strict: false })
  .validator(validateInput)
  .handler(async ({ data }) => {
    const outcome = await readForRequest(data, false);
    if (outcome.kind === 'redirect')
      throw redirect({ href: `/${data.locale}/subjects/${outcome.id}`, statusCode: 308 });
    return outcome;
  });
