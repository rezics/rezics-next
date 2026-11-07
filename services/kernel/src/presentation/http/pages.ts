import { memoizedValue } from '../../memoized.ts';
import { withHeaders } from '@elysia/openapi';
import {
  PROFILE_ROUTE_MAX_LENGTH,
  PROFILE_ROUTE_PATTERN,
  isView,
  type PageContinuation,
  type View,
} from '@rezics/composition';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { PageResponseSchema, extendPageResponseSchema } from './page-contract.ts';
import type { createApp } from '../../http/app.ts';
import { customMethod, customMethodPath } from '../../http/custom-method.ts';
import { ProblemError, problemSchema, type FieldError } from '../../http/problem.ts';
import { createAccess } from '../../access/index.ts';
import { actionCatalogue, SESSION_HEADER } from '../../http/request.ts';
import type { Access, AccessFactory } from '../../request/access.ts';
import { GLOBAL_CONTEXT } from '../../semantic/definitions.ts';
import { globalReadEligibility } from '../../semantic/eligibility.ts';
import { validateHitOptions } from '../../search/hits.ts';
import type { SessionComponent } from '../../tokens/session.ts';
import type { KeyRing } from '../../tokens/seal.ts';
import { profileSnapshot, ProfileInputError } from '../profile-cache.ts';
import { presentationApplication } from '../page-application.ts';
import type { PageTarget, PageWireResult } from '../page-contract.ts';
export { PageResponseSchema, extendPageResponseSchema } from './page-contract.ts';

function resource() {
  return memoizedValue(resource, () => ({ route: 0, id: GLOBAL_CONTEXT }));
}
const closed = { additionalProperties: false } as const;
const subjectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function profileRoute() {
  return memoizedValue(profileRoute, () => new RegExp(PROFILE_ROUTE_PATTERN, 'u'));
}
const handlePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function unauthorized() {
  return memoizedValue(unauthorized, () => problemSchema('authentication_required', 'invalid_credentials'));
}
function pageResponse() {
  return memoizedValue(pageResponse, () => PageResponseSchema);
}
function draftResponse() {
  return memoizedValue(draftResponse, () =>
    extendPageResponseSchema({
      draft: t.Object({ digest: t.String(), target: t.Any(), advice: t.Literal('allowed') }, closed),
    }),
  );
}
const pageRedirect = t.Object({ redirect: t.Object({ from: t.String(), to: t.String() }, closed) }, closed);

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
    if (key !== 'target' && key !== 'languages' && key !== 'continuation' && key !== 'stream')
      errors.push({ pointer: `/${segment(key)}`, code: 'unknown_field' });
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
    if (
      key !== 'subject' &&
      key !== 'route' &&
      key !== 'account' &&
      key !== 'view' &&
      key !== 'realm' &&
      key !== 'board'
    )
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
  let realm: string | undefined;
  if (Object.hasOwn(target, 'realm')) {
    if (named[0] !== 'subject') errors.push({ pointer: '/target/realm', code: 'unknown_field' });
    else if (typeof target.realm !== 'string' || !subjectIdPattern.test(target.realm))
      errors.push({
        pointer: '/target/realm',
        code: typeof target.realm === 'string' ? 'invalid_format' : 'invalid_type',
      });
    else realm = target.realm;
  }
  // An untrusted exact Board operand. It selects entry advice only; the Subject threads read admits it.
  let board: string | undefined;
  if (Object.hasOwn(target, 'board')) {
    if (named[0] !== 'subject') errors.push({ pointer: '/target/board', code: 'unknown_field' });
    else if (typeof target.board !== 'string' || !subjectIdPattern.test(target.board))
      errors.push({
        pointer: '/target/board',
        code: typeof target.board === 'string' ? 'invalid_format' : 'invalid_type',
      });
    else board = target.board;
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
    else if (errors.length === 0)
      return {
        subject,
        ...(realm ? { realm } : {}),
        ...(board ? { board } : {}),
        ...(view ? { view } : {}),
      };
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
    const routeKey =
      typeof route === 'string' && route.length <= PROFILE_ROUTE_MAX_LENGTH && profileRoute().test(route);
    if (!routeKey)
      errors.push({ pointer: '/target/route', code: typeof route === 'string' ? 'invalid_format' : 'invalid_type' });
    else if (errors.length === 0) return { route };
  }
  reject(errors);
}

function continuationOf(body: unknown): PageContinuation | undefined {
  if (!isRecord(body) || !Object.hasOwn(body, 'continuation')) return;
  const value = body.continuation;
  if (!isRecord(value)) reject([{ pointer: '/continuation', code: 'invalid_type' }]);
  const errors: FieldError[] = [];
  for (const key of Object.keys(value))
    if (key !== 'node' && key !== 'cursor')
      errors.push({ pointer: `/continuation/${segment(key)}`, code: 'unknown_field' });
  if (typeof value.node !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.node))
    errors.push({ pointer: '/continuation/node', code: 'invalid_format' });
  if (typeof value.cursor !== 'string' || value.cursor.length === 0)
    errors.push({ pointer: '/continuation/cursor', code: 'invalid_type' });
  if (errors.length) reject(errors);
  if (typeof value.node !== 'string' || typeof value.cursor !== 'string') throw new Error('Invalid continuation');
  return { node: value.node, cursor: value.cursor };
}

/** A selector is an address in this response's immutable composition, never a read descriptor. */
function streamOf(body: unknown): string | undefined {
  if (!isRecord(body) || !Object.hasOwn(body, 'stream')) return;
  if (typeof body.stream !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(body.stream))
    reject([{ pointer: '/stream', code: 'invalid_format' }]);
  return body.stream as string;
}

function languagesOf(body: unknown): readonly string[] | undefined {
  if (!isRecord(body) || !Object.hasOwn(body, 'languages')) return undefined;
  return validateHitOptions({ languages: body.languages }).languages;
}

function respond(result: PageWireResult, request: Request): Response {
  const headers = new Headers();
  if (result.retryAfter) headers.set('retry-after', result.retryAfter);
  headers.set('content-type', result.status >= 400 ? 'application/problem+json' : 'application/json');
  headers.set('cache-control', 'private, no-store');
  if (result.session !== null) headers.set(SESSION_HEADER, result.session);
  if (result.redirectAccount) {
    const location = new URL(request.url);
    location.pathname = customMethodPath(location.pathname);
    location.searchParams.set(
      'target',
      JSON.stringify({
        account: result.redirectAccount.handle,
        ...(result.redirectAccount.view ? { view: result.redirectAccount.view } : {}),
      }),
    );
    headers.set('location', `${location.pathname}${location.search}`);
  }
  return new Response(JSON.stringify(result.body), { status: result.status, headers });
}

function nativePageRoute<App, const Path extends string>(
  app: App,
  {
    pool,
    routeKey,
    access,
    tokens,
    clock,
    dispatch,
    deadlineNow,
  }: {
    pool: Pool;
    routeKey: Uint8Array;
    access?: Access | AccessFactory;
    tokens: KeyRing;
    clock: () => Date;
    dispatch: (request: Request) => Promise<Response>;
    /** Real wall time for the page authority's request deadlines, supplied by composition. */
    deadlineNow: () => number;
  },
  path: Path,
  draftPreview: boolean,
) {
  // A direct Access override without prepare owns its full decision and cannot evaluate domain floors.
  const includeEligibility = !access || typeof access === 'function' || typeof access.prepare === 'function';
  const routed = (app as ReturnType<typeof createApp>).post(
    path,
    {
      body: t.Any(),
      query: t.Object({ target: t.Optional(t.String()) }),
      response: {
        200: withHeaders(draftPreview ? draftResponse() : pageResponse(), { 'cache-control': t.String() }),
        202: withHeaders(t.Object({ preparing: t.Literal(true) }, closed), { 'retry-after': t.String() }),
        308: withHeaders(pageRedirect, { location: t.String() }),
        400: problemSchema('invalid_request'),
        401: unauthorized(),
        403: problemSchema('forbidden'),
        404: problemSchema('not_found'),
        503: problemSchema('presentation_not_ready', 'dependency_unavailable', 'overloaded', 'deadline_exceeded'),
      },
      detail: {
        operationId: draftPreview ? 'pages.preview_draft' : 'pages.read',
        'x-exposure': 'public',
        'x-action': draftPreview ? 'presentation:publish' : 'presentation:read',
        security: draftPreview ? [{ bearerAuth: [] }] : [{ bearerAuth: [] }, {}],
      },
    },
    async ({
      body: envelope,
      request: callerRequest,
      authorize,
      admission,
      job,
      actor: caller,
      session: requestSession,
      set,
    }) => {
      set.headers['cache-control'] = 'private, no-store';
      // Preview authorization belongs to the caller; execution belongs to an anonymous reader.
      // No caller credentials, session token or prepared capability reaches a native source.
      const headers = new Headers(callerRequest.headers);
      if (draftPreview) {
        headers.delete('authorization');
        headers.delete('cookie');
        headers.delete(SESSION_HEADER);
      }
      const request = new Request(callerRequest.url, { headers, signal: callerRequest.signal });
      const actor = draftPreview ? ({ kind: 'anonymous' } as const) : caller;
      const previewComponents: SessionComponent[] = [];
      let captured: ReturnType<typeof profileSnapshot> | undefined;
      let body = envelope;
      if (draftPreview) {
        if (caller.kind !== 'account') throw new ProblemError('forbidden');
        if (!isRecord(envelope)) reject([{ pointer: '', code: 'invalid_type' }]);
        const { profile, ...page } = envelope;
        body = page;
        try {
          // Detach before the first await, using exactly the publication validator and byte cap.
          captured = profileSnapshot(profile);
        } catch (error) {
          if (!(error instanceof ProfileInputError)) throw error;
          reject(
            error.violations.map(({ pointer, code }) => ({
              pointer: `/profile${pointer}`,
              code: code === 'limit' ? 'out_of_range' : 'invalid_format',
            })),
          );
        }
      }

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
      const continuation = continuationOf(body);
      const stream = streamOf(body);
      if (stream && (!('view' in target) || !target.view || target.view === 'overview'))
        reject([{ pointer: '/stream', code: 'unsupported' }]);
      if (stream && continuation && stream !== continuation.node)
        reject([{ pointer: '/stream', code: 'invalid_format' }]);

      const check = await authorize({
        ...resource(),
        ...(!draftPreview && includeEligibility ? { eligibility: globalReadEligibility('presentation:read') } : {}),
      });
      const pageAccess: Access =
        typeof access === 'function'
          ? access({ actions: actionCatalogue(routed) })
          : (access ?? createAccess({ actions: actionCatalogue(routed) }));
      const result = await presentationApplication().readConfiguredPage({
        execution: {
          pool,
          routeKey,
          access: pageAccess,
          tokens,
          clock,
          deadlineNow,
          dispatch,
          actor,
          deadline: job.deadline,
          request,
          run: (work) => admission.run('normal', job, work),
          record: (component) => {
            if (draftPreview) previewComponents.push(component);
            else requestSession.record(component);
          },
          sessionComponents: () => (draftPreview ? previewComponents : requestSession.components),
          admit: (client) => check(client),
          draftPreview,
          includeEligibility,
          ...(captured ? { capturedProfile: captured, draftReaders: [caller, actor] } : {}),
        },
        target,
        ...(languages === undefined ? {} : { languages }),
        ...(continuation ? { continuation } : {}),
        ...(stream ? { stream } : {}),
      });
      return respond(result, request);
    },
  );
  return routed as typeof routed & App;
}

/** Two transports select a profile; both use the same native target resolver, planner and executor. */
export function pageRoutes<App>(app: App, dependencies: Parameters<typeof nativePageRoute>[1]) {
  return nativePageRoute(
    nativePageRoute(app, dependencies, customMethod('/v1/pages', 'read'), false),
    dependencies,
    customMethod('/v1/pages', 'previewDraft'),
    true,
  );
}
