import { withHeaders } from '@elysia/openapi';
import {
  planReads,
  platformRegistry,
  PROFILE_ROUTE_MAX_LENGTH,
  PROFILE_ROUTE_PATTERN,
  resolveTemplate,
  type PageRead,
  type ResolvedTemplate,
} from '@rezics/composition';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { withConnection } from '../../database/pool.ts';
import type { createApp } from '../../http/app.ts';
import { customMethod } from '../../http/custom-method.ts';
import { ProblemError, problemSchema, type FieldError } from '../../http/problem.ts';
import { SESSION_HEADER } from '../../http/request.ts';
import type { Access, AccessFactory } from '../../request/access.ts';
import { activeRelease, GLOBAL_CONTEXT } from '../../semantic/definitions.ts';
import { globalReadEligibility } from '../../semantic/eligibility.ts';
import { decodeSession, encodeSession, mergeSession, type SessionComponent } from '../../tokens/session.ts';
import type { KeyRing } from '../../tokens/seal.ts';
import { activeProfile } from '../profiles.ts';
import { readPage } from '../reads.ts';

const resource = { route: 0, id: GLOBAL_CONTEXT };
const closed = { additionalProperties: false } as const;
const subjectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const profileRoute = new RegExp(PROFILE_ROUTE_PATTERN, 'u');
const unauthorized = problemSchema('authentication_required', 'invalid_credentials');
const readResult = t.Object({ status: t.Integer(), body: t.Any() }, closed);
const pageResponse = t.Object(
  {
    subject: t.Optional(t.String()),
    profile: t.String(),
    template: t.Object(
      {
        scope: t.Union([t.Literal('route'), t.Literal('type'), t.Literal('base'), t.Literal('generic')]),
        key: t.Union([t.String(), t.Null()]),
      },
      closed,
    ),
    document: t.Any(),
    reads: t.Record(t.String(), readResult),
  },
  closed,
);

type ReadResult = { status: number; body: unknown };
type PageTarget = { subject: string } | { route: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function segment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function reject(errors: FieldError[]): never {
  const sorted = [...errors].sort((left, right) =>
    left.pointer < right.pointer ? -1 : left.pointer > right.pointer ? 1 : 0,
  );
  throw new ProblemError('invalid_request', { errors: sorted });
}

/** Closed target: exactly one of a canonical subject id or a profile route key. */
function targetOf(body: unknown): PageTarget {
  const errors: FieldError[] = [];
  if (!isRecord(body)) reject([{ pointer: '', code: 'invalid_type' }]);
  for (const key of Object.keys(body)) {
    if (key !== 'target') errors.push({ pointer: `/${segment(key)}`, code: 'unknown_field' });
  }
  if (!Object.hasOwn(body, 'target')) {
    errors.push({ pointer: '/target', code: 'required' });
    reject(errors);
  }
  const target = body.target;
  if (!isRecord(target)) {
    errors.push({ pointer: '/target', code: 'invalid_type' });
    reject(errors);
  }
  for (const key of Object.keys(target)) {
    if (key !== 'subject' && key !== 'route')
      errors.push({ pointer: `/target/${segment(key)}`, code: 'unknown_field' });
  }
  const hasSubject = Object.hasOwn(target, 'subject');
  const hasRoute = Object.hasOwn(target, 'route');
  if (hasSubject === hasRoute) {
    errors.push({ pointer: '/target', code: 'invalid_type' });
    reject(errors);
  }
  if (hasSubject) {
    const subject = target.subject;
    if (typeof subject !== 'string' || !subjectIdPattern.test(subject))
      errors.push({
        pointer: '/target/subject',
        code: typeof subject === 'string' ? 'invalid_format' : 'invalid_type',
      });
    else if (errors.length === 0) return { subject };
  } else {
    const route = target.route;
    const routeKey = typeof route === 'string' && route.length <= PROFILE_ROUTE_MAX_LENGTH && profileRoute.test(route);
    if (!routeKey)
      errors.push({ pointer: '/target/route', code: typeof route === 'string' ? 'invalid_format' : 'invalid_type' });
    else if (errors.length === 0) return { route };
  }
  reject(errors);
}

function survivor(body: unknown): { id: string; type: string } {
  if (!isRecord(body) || !isRecord(body.subject)) throw new Error('Subject read did not return a subject');
  const { id, type } = body.subject;
  if (typeof id !== 'string' || typeof type !== 'string') throw new Error('Subject read did not return a subject');
  return { id, type };
}

function mergedSession(ring: KeyRing, scope: string, first: string | null, second: string | null): string | null {
  if (first === null) return second;
  if (second === null) return first;
  const base = decodeSession(ring, scope, first);
  const extra = decodeSession(ring, scope, second);
  if (!base) return second;
  if (!extra) return first;
  let components: SessionComponent[] = base;
  for (const component of extra) components = mergeSession(components, component);
  return encodeSession(ring, scope, components);
}

function respond(status: number, body: unknown, session: string | null, cache: boolean): Response {
  const headers = new Headers();
  headers.set('content-type', status >= 400 ? 'application/problem+json' : 'application/json');
  if (cache) headers.set('cache-control', 'private, no-store');
  if (session !== null) headers.set(SESSION_HEADER, session);
  return new Response(JSON.stringify(body), { status, headers });
}

export function pageRoutes<App>(
  app: App,
  {
    pool,
    access,
    tokens,
    dispatch,
  }: {
    pool: Pool;
    access?: Access | AccessFactory;
    tokens: KeyRing;
    dispatch: (request: Request) => Promise<Response>;
  },
) {
  // A direct Access override without prepare owns its full decision and cannot evaluate domain floors.
  const includeEligibility = !access || typeof access === 'function' || typeof access.prepare === 'function';
  const routed = (app as ReturnType<typeof createApp>).post(
    customMethod('/v1/pages', 'read'),
    {
      body: t.Any(),
      response: {
        200: withHeaders(pageResponse, { 'cache-control': t.String() }),
        400: problemSchema('invalid_request'),
        401: unauthorized,
        404: problemSchema('not_found'),
        503: problemSchema('presentation_not_ready', 'overloaded', 'deadline_exceeded'),
      },
      detail: {
        operationId: 'pages.read',
        'x-exposure': 'public',
        'x-action': 'presentation:read',
        security: [{ bearerAuth: [] }, {}],
      },
    },
    async ({ body, request, authorize, admission, job, actor }) => {
      const target = targetOf(body);
      const check = await authorize({
        ...resource,
        ...(includeEligibility ? { eligibility: globalReadEligibility('presentation:read') } : {}),
      });
      // The slot ends before any sub-read. Each sub-read takes its own slot.
      const active = await admission.run('normal', job, async () => {
        if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('not_found');
        return activeProfile(pool);
      });
      if (!active) throw new ProblemError('presentation_not_ready', { headers: { 'retry-after': '1' } });

      const scope = actor.kind === 'account' ? `account:${actor.accountId}` : 'anonymous';
      const session = { ring: tokens, scope };
      let probe: ReadResult | undefined;
      let probeSession: string | null = null;
      let subjectId: string | null = null;
      let resolved: ResolvedTemplate;
      if ('subject' in target) {
        const probed = await readPage({
          dispatch,
          incoming: request,
          reads: { subject: { kind: 'subject', id: target.subject } },
          session,
        });
        probe = probed.results.subject;
        probeSession = probed.session;
        if (!probe || probe.status !== 200)
          return respond(probe?.status ?? 500, probe?.body ?? null, probeSession, false);
        const subject = survivor(probe.body);
        subjectId = subject.id;
        const release = await activeRelease(pool);
        const definition = release?.release.types[subject.type];
        resolved = resolveTemplate(active.profile, {
          type: subject.type,
          ...(definition === undefined ? {} : { bases: definition.bases }),
        });
      } else {
        resolved = resolveTemplate(active.profile, { route: target.route });
      }

      return pageAnswer({
        dispatch,
        request,
        session,
        digest: active.digest,
        resolved,
        subjectId,
        probe,
        probeSession,
      });
    },
  );
  return routed as typeof routed & App;
}

async function pageAnswer(input: {
  dispatch: (request: Request) => Promise<Response>;
  request: Request;
  session: { ring: KeyRing; scope: string };
  digest: string;
  resolved: ResolvedTemplate;
  subjectId: string | null;
  probe: ReadResult | undefined;
  probeSession: string | null;
}): Promise<Response> {
  const plan = planReads(platformRegistry, input.resolved.document, { subject: input.subjectId });
  const pending: Record<string, PageRead> = {};
  let reused: string | undefined;
  for (const [key, descriptor] of Object.entries(plan.reads)) {
    if (input.probe && descriptor.kind === 'subject' && descriptor.id === input.subjectId) reused = key;
    else pending[key] = descriptor;
  }

  let executed: Record<string, ReadResult> = {};
  let executedSession: string | null = null;
  if (Object.keys(pending).length > 0) {
    const page = await readPage({
      dispatch: input.dispatch,
      incoming: input.request,
      reads: pending,
      session: input.session,
    });
    executed = page.results;
    executedSession = page.session;
  }

  const reads: Record<string, ReadResult> = {};
  for (const key of Object.keys(plan.reads)) {
    const result = key === reused ? input.probe : executed[key];
    if (!result) throw new Error('Page read did not return a result');
    reads[key] = result;
  }

  return respond(
    200,
    {
      ...(input.subjectId === null ? {} : { subject: input.subjectId }),
      profile: input.digest,
      template: { scope: input.resolved.scope, key: input.resolved.key },
      document: input.resolved.document,
      reads,
    },
    mergedSession(input.session.ring, input.session.scope, input.probeSession, executedSession),
    true,
  );
}
