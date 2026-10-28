import { withHeaders } from '@elysia/openapi';
import canonicalize from 'canonicalize';
import {
  planReads,
  platformRegistry,
  PROFILE_ROUTE_MAX_LENGTH,
  PROFILE_ROUTE_PATTERN,
  definedViews,
  isView,
  resolveTemplate,
  resolveView,
  type PageRead,
  type ResolvedTemplate,
  type TemplateTarget,
  type View,
} from '@rezics/composition';
import { t } from 'elysia';
import type { Pool } from 'pg';
import type { TProperties } from 'typebox';
import { readPublicAccountByAgent } from '../../access/account-data.ts';
import { withConnection } from '../../database/pool.ts';
import type { createApp } from '../../http/app.ts';
import { customMethod, customMethodPath } from '../../http/custom-method.ts';
import { ProblemError, problemSchema, type FieldError } from '../../http/problem.ts';
import { SESSION_HEADER } from '../../http/request.ts';
import type { Access, AccessFactory } from '../../request/access.ts';
import { activeRelease, GLOBAL_CONTEXT } from '../../semantic/definitions.ts';
import { globalReadEligibility } from '../../semantic/eligibility.ts';
import { validateHitOptions } from '../../search/hits.ts';
import { decodeSession, encodeSession, mergeSession, type SessionComponent } from '../../tokens/session.ts';
import type { KeyRing } from '../../tokens/seal.ts';
import { activeProfile } from '../profiles.ts';
import { readPage } from '../reads.ts';

const resource = { route: 0, id: GLOBAL_CONTEXT };
const closed = { additionalProperties: false } as const;
const subjectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const profileRoute = new RegExp(PROFILE_ROUTE_PATTERN, 'u');
const handlePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const unauthorized = problemSchema('authentication_required', 'invalid_credentials');
const readResult = t.Object({ status: t.Integer(), body: t.Any() }, closed);
export const PageResponseSchema = t.Object(
  {
    subject: t.Optional(t.String()),
    account: t.Optional(t.String()),
    profile: t.String(),
    template: t.Object(
      {
        scope: t.Union([t.Literal('route'), t.Literal('type'), t.Literal('base'), t.Literal('generic')]),
        key: t.Union([t.String(), t.Null()]),
      },
      closed,
    ),
    document: t.Any(),
    views: t.Optional(t.Array(t.String())),
    reads: t.Record(t.String(), readResult),
  },
  closed,
);

/** Builds a closed top-level extension of the common page response without mutating its schema. */
export function extendPageResponseSchema<Extension extends TProperties>(extension: Extension) {
  return t.Object({ ...PageResponseSchema.properties, ...extension }, closed);
}

const pageResponse = PageResponseSchema;
const pageRedirect = t.Object({ redirect: t.Object({ from: t.String(), to: t.String() }, closed) }, closed);

type ReadResult = { status: number; body: unknown };
type PageAccount = { id: string; handle: string; automated: boolean; operatorId: string | null };
type PageTarget = ({ subject: string } | { route: string } | { account: string }) & { view?: View };

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

/**
 * Closed target: exactly one of a canonical subject id, a profile route key or an account handle. A subject or account
 * target may name one view; without it the page is the overview.
 */
function targetOf(body: unknown): PageTarget {
  const errors: FieldError[] = [];
  if (!isRecord(body)) reject([{ pointer: '', code: 'invalid_type' }]);
  for (const key of Object.keys(body)) {
    if (key !== 'target' && key !== 'languages') errors.push({ pointer: `/${segment(key)}`, code: 'unknown_field' });
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
    if (key !== 'subject' && key !== 'route' && key !== 'account' && key !== 'view')
      errors.push({ pointer: `/target/${segment(key)}`, code: 'unknown_field' });
  }
  const named = ['subject', 'route', 'account'].filter((key) => Object.hasOwn(target, key));
  let view: View | undefined;
  if (Object.hasOwn(target, 'view')) {
    if (!isView(target.view))
      errors.push({
        pointer: '/target/view',
        code: typeof target.view === 'string' ? 'invalid_format' : 'invalid_type',
      });
    else if (named[0] === 'route') errors.push({ pointer: '/target/view', code: 'unknown_field' });
    else view = target.view;
  }
  if (named.length !== 1) {
    errors.push({ pointer: '/target', code: 'invalid_type' });
    reject(errors);
  }
  if (named[0] === 'subject') {
    const subject = target.subject;
    if (typeof subject !== 'string' || !subjectIdPattern.test(subject))
      errors.push({
        pointer: '/target/subject',
        code: typeof subject === 'string' ? 'invalid_format' : 'invalid_type',
      });
    else if (errors.length === 0) return { subject, ...(view ? { view } : {}) };
  } else if (named[0] === 'account') {
    const account = target.account;
    if (typeof account !== 'string' || !handlePattern.test(account))
      errors.push({
        pointer: '/target/account',
        code: typeof account === 'string' ? 'invalid_format' : 'invalid_type',
      });
    else if (errors.length === 0) return { account, ...(view ? { view } : {}) };
  } else {
    const route = target.route;
    const routeKey = typeof route === 'string' && route.length <= PROFILE_ROUTE_MAX_LENGTH && profileRoute.test(route);
    if (!routeKey)
      errors.push({ pointer: '/target/route', code: typeof route === 'string' ? 'invalid_format' : 'invalid_type' });
    else if (errors.length === 0) return { route };
  }
  reject(errors);
}

function languagesOf(body: unknown): readonly string[] | undefined {
  if (!isRecord(body) || !Object.hasOwn(body, 'languages')) return undefined;
  return validateHitOptions({ languages: body.languages }).languages;
}

function survivor(body: unknown): { id: string; type: string } {
  if (!isRecord(body) || !isRecord(body.subject)) throw new Error('Subject read did not return a subject');
  const { id, type } = body.subject;
  if (typeof id !== 'string' || typeof type !== 'string') throw new Error('Subject read did not return a subject');
  return { id, type };
}

/** The public account the account probe returned, or null when it is unknown, deleted or not visible. */
function accountOf(body: unknown): {
  id: string;
  kind: string;
  state: string;
  subject: string | null;
  automated: boolean;
  operatorId: string | null;
} | null {
  if (!isRecord(body) || !Array.isArray(body.accounts)) throw new Error('Account read did not return accounts');
  if (body.accounts.length === 0) return null;
  const account = body.accounts[0];
  if (
    !isRecord(account) ||
    typeof account.id !== 'string' ||
    typeof account.kind !== 'string' ||
    typeof account.state !== 'string'
  )
    throw new Error('Account read did not return an account');
  const subject = isRecord(account.subject) && typeof account.subject.id === 'string' ? account.subject.id : null;
  return {
    id: account.id,
    kind: account.kind,
    state: account.state,
    subject,
    automated: account.automated === true,
    operatorId: typeof account.operatorId === 'string' ? account.operatorId : null,
  };
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
      query: t.Object({ target: t.Optional(t.String()) }),
      response: {
        200: withHeaders(pageResponse, { 'cache-control': t.String() }),
        308: withHeaders(pageRedirect, { location: t.String() }),
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
      // A 308 preserves the POST body; its Location supplies the replacement page target.
      const encodedTarget = new URL(request.url).searchParams.get('target');
      let redirectedTarget: unknown;
      if (encodedTarget !== null) {
        try {
          redirectedTarget = JSON.parse(encodedTarget);
        } catch {
          reject([{ pointer: '/target', code: 'invalid_format' }]);
        }
      }
      const target = targetOf(
        encodedTarget === null ? body : { ...(isRecord(body) ? body : {}), target: redirectedTarget },
      );
      const languages = languagesOf(body);
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
      const probes = new Map<string, ReadResult>();
      let probeSession: string | null = null;
      // Run one probe read; its non-200 answer is the page's answer.
      const probe = async (descriptor: PageRead): Promise<ReadResult> => {
        const probed = await readPage({ dispatch, incoming: request, reads: { probe: descriptor }, session });
        probeSession = mergedSession(tokens, scope, probeSession, probed.session);
        const result = probed.results.probe!;
        probes.set(canonicalize(descriptor)!, result);
        return result;
      };
      const subjectProbe = async (id: string) => {
        const result = await probe({ kind: 'subject', id });
        if (result.status !== 200) return { failed: result } as const;
        const found = survivor(result.body);
        // The planned subject read names the survivor of a redirect, so the probe answers that descriptor too.
        probes.set(canonicalize({ kind: 'subject', id: found.id })!, result);
        return { subject: found } as const;
      };
      let subject: { id: string; type: string } | null = null;
      let account: PageAccount | null = null;
      let resolved: ResolvedTemplate;
      let views: View[] | null = null;
      if ('route' in target) {
        resolved = resolveTemplate(active.profile, { route: target.route });
      } else {
        let subjectTarget: string | null = null;
        let kind = 'actor';
        let automated = false;
        if ('subject' in target) {
          subjectTarget = target.subject;
        } else {
          const result = await probe({ kind: 'account', handle: target.account });
          if (result.status !== 200) return respond(result.status, result.body, probeSession, false);
          const found = accountOf(result.body);
          if (found === null || found.state !== 'active') throw new ProblemError('not_found');
          account = { id: found.id, handle: target.account, automated: found.automated, operatorId: found.operatorId };
          subjectTarget = found.subject;
          kind = found.kind;
          automated = found.automated;
        }
        if (subjectTarget !== null) {
          const probed = await subjectProbe(subjectTarget);
          if ('failed' in probed) return respond(probed.failed.status, probed.failed.body, probeSession, false);
          subject = probed.subject;
          if ('subject' in target) {
            const [agent] = await admission.run('normal', job, () =>
              readPublicAccountByAgent(pool, probed.subject.id, { includeSuspended: true }),
            );
            if (agent && agent.state !== 'deleted' && agent.handle !== null) {
              const location = new URL(request.url);
              location.pathname = customMethodPath(location.pathname);
              location.searchParams.set(
                'target',
                JSON.stringify({ account: agent.handle, ...(target.view ? { view: target.view } : {}) }),
              );
              const response = respond(
                308,
                { redirect: { from: target.subject, to: agent.handle } },
                probeSession,
                true,
              );
              response.headers.set('location', `${location.pathname}${location.search}`);
              return response;
            }
          }
        }
        const release = await activeRelease(pool);
        // An account without a named subject takes the template of its kind's agent type.
        const type =
          subject?.type ??
          (kind === 'organization'
            ? 'schema:Organization'
            : automated
              ? 'schema:SoftwareApplication'
              : 'schema:Person');
        const definition = release?.release.types[type];
        const template: TemplateTarget = {
          type,
          ...(definition === undefined ? {} : { bases: definition.bases }),
        };
        // A view no template of the order defines does not exist for this page.
        const found = resolveView(active.profile, template, target.view ?? 'overview');
        if (found === null) throw new ProblemError('not_found');
        resolved = found;
        views = definedViews(active.profile, template);
      }

      return pageAnswer({
        dispatch,
        request,
        session,
        digest: active.digest,
        resolved,
        views,
        subject: subject?.id ?? null,
        account,
        probes,
        probeSession,
        ...(languages === undefined ? {} : { languages }),
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
  views: View[] | null;
  subject: string | null;
  account: PageAccount | null;
  probes: Map<string, ReadResult>;
  probeSession: string | null;
  languages?: readonly string[];
}): Promise<Response> {
  // The probes already ran; plan once and run what they did not answer in one call.
  const plan = planReads(platformRegistry, input.resolved.document, { subject: input.subject, account: input.account });
  const results = new Map(input.probes);
  const pending: Record<string, PageRead> = {};
  for (const descriptor of Object.values(plan.reads)) {
    const key = canonicalize(descriptor)!;
    if (!results.has(key)) pending[`p${Object.keys(pending).length}`] = descriptor;
  }
  let readSession = input.probeSession;
  if (Object.keys(pending).length > 0) {
    const page = await readPage({
      dispatch: input.dispatch,
      incoming: input.request,
      reads: pending,
      session: input.session,
      ...(input.languages === undefined ? {} : { languages: input.languages }),
    });
    for (const [key, descriptor] of Object.entries(pending)) results.set(canonicalize(descriptor)!, page.results[key]!);
    readSession = mergedSession(input.session.ring, input.session.scope, readSession, page.session);
  }

  const reads: Record<string, ReadResult> = {};
  for (const [key, descriptor] of Object.entries(plan.reads)) {
    const result = results.get(canonicalize(descriptor)!);
    if (!result) throw new Error('Page read did not return a result');
    reads[key] = result;
  }

  return respond(
    200,
    {
      ...(input.subject === null ? {} : { subject: input.subject }),
      ...(input.account === null ? {} : { account: input.account.id }),
      profile: input.digest,
      template: { scope: input.resolved.scope, key: input.resolved.key },
      document: input.resolved.document,
      ...(input.views === null ? {} : { views: input.views }),
      reads,
    },
    readSession,
    true,
  );
}
