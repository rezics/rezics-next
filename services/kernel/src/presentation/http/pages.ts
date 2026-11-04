import { createBuiltinRuntime } from '../../library/builtin-runtime.ts';
import { withHeaders } from '@elysia/openapi';
import canonicalize from 'canonicalize';
import {
  planReads,
  profileDigest,
  validateProfileFilters,
  validateDocumentFilters,
  documentRead,
  readCost,
  MAX_PAGE_COST,
  PageContinuationError,
  PageReadLimitError,
  type PageContinuation,
  type SelectedContext,
  platformRegistry,
  PROFILE_ROUTE_MAX_LENGTH,
  PROFILE_ROUTE_PATTERN,
  isView,
  resolveTemplate,
  type PageRead,
  type ResolvedTemplate,
  type View,
} from '@rezics/composition';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { readPublicAccountByAgent } from '../../access/account-data.ts';
import { PageResponseSchema, extendPageResponseSchema } from './page-contract.ts';
import { deadlineClient } from '../../access/authenticate.ts';
import { AccessUnavailableError } from '../../access/unavailable.ts';
import { readItemTypes } from '../../semantic/subject.ts';
import { withConnection } from '../../database/pool.ts';
import type { createApp } from '../../http/app.ts';
import { customMethod, customMethodPath } from '../../http/custom-method.ts';
import { ProblemError, problemSchema, type FieldError } from '../../http/problem.ts';
import { createAccess } from '../../access/index.ts';
import { actionCatalogue } from '../../http/request.ts';
import { SESSION_HEADER } from '../../http/request.ts';
import { accessCheck, type Access, type AccessFactory } from '../../request/access.ts';
import { activeRelease, GLOBAL_CONTEXT } from '../../semantic/definitions.ts';
import { globalReadEligibility } from '../../semantic/eligibility.ts';
import { validateHitOptions } from '../../search/hits.ts';
import { decodeSession, encodeSession, mergeSession, type SessionComponent } from '../../tokens/session.ts';
import type { KeyRing } from '../../tokens/seal.ts';
import { activeProfile } from '../profiles.ts';
import { profileSnapshot, ProfileInputError } from '../profile-cache.ts';
import {
  cataloguePageMetadata,
  characterWorkIdentityOverlay,
  copyWorkDisclosureOverlay,
  pageViewerActions,
  quotationPageDocuments,
  quotationTypeAdmitted,
  readQuotationPageAuthority,
  semanticPageView,
  type SemanticPageOverlay,
} from '../semantic-page.ts';
import { readPage, PageReadBudget, PageReadError } from '../reads.ts';
import { selectPage, guardSelectedPage, type SelectedPage } from '../selected-page.ts';
export { PageResponseSchema, extendPageResponseSchema } from './page-contract.ts';

const resource = { route: 0, id: GLOBAL_CONTEXT };
const closed = { additionalProperties: false } as const;
const subjectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const profileRoute = new RegExp(PROFILE_ROUTE_PATTERN, 'u');
const handlePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const unauthorized = problemSchema('authentication_required', 'invalid_credentials');
const pageResponse = PageResponseSchema;
const draftResponse = extendPageResponseSchema({
  draft: t.Object({ digest: t.String(), target: t.Any(), advice: t.Literal('allowed') }, closed),
});
const pageRedirect = t.Object({ redirect: t.Object({ from: t.String(), to: t.String() }, closed) }, closed);

type ReadResult = { status: number; body: unknown };
type PageAccount = { id: string; handle: string; automated: boolean; operatorId: string | null };
type PageTarget = ({ subject: string; realm?: string } | { route: string } | { account: string }) & { view?: View };

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
    if (key !== 'target' && key !== 'languages' && key !== 'continuation')
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
    if (key !== 'subject' && key !== 'route' && key !== 'account' && key !== 'view' && key !== 'realm')
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
    else if (errors.length === 0) return { subject, ...(realm ? { realm } : {}), ...(view ? { view } : {}) };
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

function nativePageRoute<App>(
  app: App,
  {
    pool,
    routeKey,
    access,
    tokens,
    dispatch,
  }: {
    pool: Pool;
    routeKey: Uint8Array;
    access?: Access | AccessFactory;
    tokens: KeyRing;
    dispatch: (request: Request) => Promise<Response>;
  },
  draftPreview: boolean,
) {
  // A direct Access override without prepare owns its full decision and cannot evaluate domain floors.
  const includeEligibility = !access || typeof access === 'function' || typeof access.prepare === 'function';
  const routed = (app as ReturnType<typeof createApp>).post(
    customMethod('/v1/pages', draftPreview ? 'previewDraft' : 'read'),
    {
      body: t.Any(),
      query: t.Object({ target: t.Optional(t.String()) }),
      response: {
        200: withHeaders(draftPreview ? draftResponse : pageResponse, { 'cache-control': t.String() }),
        308: withHeaders(pageRedirect, { location: t.String() }),
        400: problemSchema('invalid_request'),
        401: unauthorized,
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
      const check = await authorize({
        ...resource,
        ...(!draftPreview && includeEligibility ? { eligibility: globalReadEligibility('presentation:read') } : {}),
      });
      const pageAccess: Access =
        typeof access === 'function'
          ? access({ actions: actionCatalogue(routed) })
          : (access ?? createAccess({ actions: actionCatalogue(routed) }));
      // The slot ends before any sub-read. Each sub-read takes its own slot.
      const active = await admission.run('normal', job, async () => {
        if (!(await withConnection(pool, (client) => check(client))))
          throw new ProblemError(draftPreview ? 'forbidden' : 'not_found');
        if (!captured) return activeProfile(pool);
        const readResource = {
          ...resource,
          ...(includeEligibility ? { eligibility: globalReadEligibility('presentation:read') } : {}),
        };
        // Validity does not confer authority. Both the curator and public reader must be admitted.
        for (const reader of [caller, actor]) {
          const readCheck = await accessCheck(pageAccess, reader, 'presentation:read', readResource, {
            pool,
            deadline: job.deadline,
          });
          if (!(await withConnection(pool, (client) => readCheck(client)))) throw new ProblemError('forbidden');
        }
        const release = await activeRelease(pool);
        const violations = validateProfileFilters(
          platformRegistry,
          captured,
          release?.release ?? { types: {}, properties: {} },
        );
        if (violations.length)
          reject(
            violations.map(({ pointer, code }) => ({
              pointer: `/profile${pointer}`,
              code: code === 'limit' ? 'out_of_range' : 'unsupported',
            })),
          );
        if ('route' in target && !captured.routes.some((entry) => entry.route === target.route))
          reject([{ pointer: '/target/route', code: 'unsupported' }]);
        return { digest: profileDigest(captured), profile: captured };
      });
      if (!active) throw new ProblemError('presentation_not_ready', { headers: { 'retry-after': '1' } });

      const scope = actor.kind === 'account' ? `account:${actor.accountId}` : 'anonymous';
      const session = { ring: tokens, scope };
      const budget = new PageReadBudget();
      const probes = new Map<string, ReadResult>();
      let probeSession: string | null = null;
      // Run one probe read; its non-200 answer is the page's answer.
      const probe = async (descriptor: PageRead): Promise<ReadResult> => {
        const incoming = new Request(request.url, { headers: request.headers, signal: request.signal });
        const forwarded = mergedSession(tokens, scope, incoming.headers.get(SESSION_HEADER), probeSession);
        if (forwarded !== null) incoming.headers.set(SESSION_HEADER, forwarded);
        const probed = await readPage({
          dispatch,
          incoming,
          reads: { probe: descriptor },
          session,
          budget,
          ...(languages ? { languages } : {}),
        });
        probeSession = mergedSession(tokens, scope, probeSession, probed.session);
        const result = probed.results.probe!;
        probes.set(canonicalize(descriptor)!, result);
        return result;
      };
      let selected: SelectedPage | undefined;
      const authority = {
        deps: {
          pool,
          access: pageAccess,
          routeKey,
        },
        actor,
        deadline: job.deadline,
        run: <T>(work: () => Promise<T>) => admission.run('normal', job, work),
        record: (component: SessionComponent) => {
          if (draftPreview) previewComponents.push(component);
          else requestSession.record(component);
        },
      };
      const subjectProbe = async (id: string) => {
        const context = selected ? { context: selected.context.id } : {};
        const result = await probe({ kind: 'subject', id, ...context });
        if (result.status !== 200) return { failed: result } as const;
        const found = survivor(result.body);
        // The planned subject read names the survivor of a redirect, so the probe answers that descriptor too.
        probes.set(canonicalize({ kind: 'subject', id: found.id, ...context })!, result);
        return { subject: found } as const;
      };
      let subject: { id: string; type: string } | null = null;
      let account: PageAccount | null = null;
      let resolved: ResolvedTemplate;
      let views: View[] | null = null;
      let definitionRelease: Awaited<ReturnType<typeof activeRelease>> | undefined;
      if ('route' in target) {
        resolved = resolveTemplate(active.profile, { route: target.route });
      } else {
        const release = await activeRelease(pool);
        definitionRelease = release;
        let subjectTarget: string | null = null;
        let kind = 'actor';
        let automated = false;
        if ('subject' in target) {
          subjectTarget = target.subject;
          if (target.realm) {
            // Agent addresses always resolve through Global. This native identity point reads no facts or candidates.
            const types = await admission.run('normal', job, () =>
              withConnection(pool, (client) => readItemTypes(deadlineClient(client, job.deadline), [target.subject])),
            );
            const roots = new Set(['schema:Person', 'schema:Organization', 'schema:SoftwareApplication']);
            const visited = new Set<string>();
            const agentType = (type: string): boolean => {
              if (roots.has(type)) return true;
              if (visited.has(type)) return false;
              visited.add(type);
              return (release?.release.types[type]?.bases ?? []).some(agentType);
            };
            const type = types.get(target.subject);
            if (!type || !agentType(type)) selected = await selectPage(authority, target.realm, subjectTarget);
          }
        } else {
          const result = await probe({ kind: 'account', handle: target.account });
          if (result.status !== 200) return respond(result.status, result.body, probeSession, draftPreview);
          const found = accountOf(result.body);
          if (found === null || found.state !== 'active') throw new ProblemError('not_found');
          account = { id: found.id, handle: target.account, automated: found.automated, operatorId: found.operatorId };
          subjectTarget = found.subject;
          kind = found.kind;
          automated = found.automated;
        }
        if (subjectTarget !== null) {
          const probed = await subjectProbe(subjectTarget);
          if ('failed' in probed) return respond(probed.failed.status, probed.failed.body, probeSession, draftPreview);
          subject = probed.subject;
          if ('subject' in target) {
            const [agent] = await admission.run('normal', job, () => readPublicAccountByAgent(pool, probed.subject.id));
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
        // An account without a named subject takes the template of its kind's agent type.
        const type =
          subject?.type ??
          (kind === 'organization'
            ? 'schema:Organization'
            : automated
              ? 'schema:SoftwareApplication'
              : 'schema:Person');
        const page = semanticPageView(active.profile, release?.release, type, target.view ?? 'overview');
        if (page === null) throw new ProblemError('not_found');
        resolved = page.resolved;
        views = page.views;
      }

      probeSession = mergedSession(
        tokens,
        scope,
        probeSession,
        encodeSession(tokens, scope, draftPreview ? previewComponents : requestSession.components),
      );
      const initialSubjectDescriptor = subject
        ? { kind: 'subject' as const, id: subject.id, ...(selected ? { context: selected.context.id } : {}) }
        : undefined;
      const initialSubject = initialSubjectDescriptor
        ? probes.get(canonicalize(initialSubjectDescriptor)!)?.body
        : undefined;
      const properties =
        isRecord(initialSubject) && isRecord(initialSubject.subject) && isRecord(initialSubject.subject.statements)
          ? Object.keys(initialSubject.subject.statements)
          : [];
      const plannedDocuments = documentRead(resolved.document, subject?.id ?? null, properties, selected?.context.id);
      const pageCatalogue = subject
        ? cataloguePageMetadata(definitionRelease?.release, definitionRelease?.digest, subject.type)
        : undefined;
      const identityOverlay =
        subject && definitionRelease?.release
          ? (characterWorkIdentityOverlay(definitionRelease.release, subject.type, languages?.[0] ?? 'en') ??
            copyWorkDisclosureOverlay(definitionRelease.release, subject.type, languages?.[0] ?? 'en'))
          : undefined;
      const pageViewer =
        pageCatalogue?.state === 'released' || identityOverlay
          ? async () => {
              let statementPropose: 'allowed' | 'denied' | 'unavailable';
              try {
                const check = await accessCheck(authority.deps.access, actor, 'statement:propose', resource, {
                  pool,
                  deadline: job.deadline,
                });
                statementPropose = (await admission.run('normal', job, () =>
                  withConnection(pool, (client) => check(client)),
                ))
                  ? 'allowed'
                  : 'denied';
              } catch (error) {
                if (!(error instanceof AccessUnavailableError)) throw error;
                statementPropose = 'unavailable';
              }
              return {
                state: actor.kind === 'account' ? ('account' as const) : ('anonymous' as const),
                ...(actor.kind === 'account' ? { account: actor.accountId } : {}),
                context: selected?.context.id ?? GLOBAL_CONTEXT,
                actions: { statementPropose },
              };
            }
          : undefined;
      return pageAnswer({
        release: definitionRelease?.release,
        continuationOnlyLists: !('subject' in target) || !target.view || target.view === 'overview',
        ...(selected ? { context: selected.context } : {}),
        ...(selected || plannedDocuments
          ? {
              finalGuard: async (readSession: string | null) => {
                const incoming = new Request(request, { headers: request.headers });
                if (readSession !== null) incoming.headers.set(SESSION_HEADER, readSession);
                const descriptor = {
                  kind: 'subject' as const,
                  id: subject!.id,
                  ...(selected ? { context: selected.context.id } : {}),
                };
                const current = await readPage({
                  dispatch,
                  incoming,
                  reads: { guard: descriptor },
                  session,
                  budget,
                  ...(languages ? { languages } : {}),
                });
                probeSession = mergedSession(tokens, scope, probeSession, current.session);
                const result = current.results.guard!;
                if (result.status !== 200)
                  throw new ProblemError(result.status === 404 ? 'not_found' : 'dependency_unavailable', {
                    headers: { 'retry-after': '1' },
                  });
                const initial = probes.get(canonicalize(descriptor)!);
                if (
                  survivor(result.body).id !== subject!.id ||
                  canonicalize(result.body) !== canonicalize(initial?.body)
                )
                  throw new ProblemError('dependency_unavailable', { headers: { 'retry-after': '1' } });
                if (selected) await guardSelectedPage(authority, selected);
                return mergedSession(
                  tokens,
                  scope,
                  current.session,
                  encodeSession(tokens, scope, draftPreview ? previewComponents : requestSession.components),
                );
              },
            }
          : {}),
        ...(continuation ? { continuation } : {}),
        resolveBuiltin: async (key) => {
          if (actor.kind !== 'account' || (account !== null && account.id !== actor.accountId)) return null;
          return admission.run('normal', job, () => createBuiltinRuntime({ pool }).resolve(actor, key, job.deadline));
        },
        dispatch,
        request,
        session,
        digest: active.digest,
        ...(draftPreview ? { draft: { digest: active.digest, target, advice: 'allowed' as const } } : {}),
        ...(pageCatalogue ? { catalogue: pageCatalogue } : {}),
        ...(pageViewer ? { viewer: pageViewer } : {}),
        ...(identityOverlay ? { overlay: identityOverlay } : {}),
        resolved,
        views,
        subject: subject?.id ?? null,
        subjectType: subject?.type ?? null,
        account,
        probes,
        budget,
        probeSession,
        actor,
        access: authority.deps.access,
        pool,
        deadline: job.deadline,
        ...(languages === undefined ? {} : { languages }),
      });
    },
  );
  return routed as typeof routed & App;
}

/** Two transports select a profile; both use the same native target resolver, planner and executor. */
export function pageRoutes<App>(app: App, dependencies: Parameters<typeof nativePageRoute>[1]) {
  return nativePageRoute(nativePageRoute(app, dependencies, false), dependencies, true);
}

async function pageAnswer(input: {
  release: import('@rezics/filter').FilterRelease | undefined;
  continuationOnlyLists: boolean;
  dispatch: (request: Request) => Promise<Response>;
  request: Request;
  session: { ring: KeyRing; scope: string };
  digest: string;
  draft?: { digest: string; target: PageTarget; advice: 'allowed' };
  resolved: ResolvedTemplate;
  views: View[] | null;
  subject: string | null;
  subjectType: string | null;
  account: PageAccount | null;
  probes: Map<string, ReadResult>;
  budget: PageReadBudget;
  probeSession: string | null;
  languages?: readonly string[];
  context?: SelectedContext;
  continuation?: PageContinuation;
  finalGuard?: (session: string | null) => Promise<string | null>;
  resolveBuiltin: NonNullable<Parameters<typeof readPage>[0]['resolveBuiltin']>;
  catalogue?: ReturnType<typeof cataloguePageMetadata>;
  overlay?: SemanticPageOverlay;
  viewer?: () => Promise<{
    state: 'anonymous' | 'account';
    account?: string;
    context: string;
    actions: { statementPropose: 'allowed' | 'denied' | 'unavailable' };
  }>;
  actor: import('../../request/access.ts').Actor;
  access: Access;
  pool: Pool;
  deadline: number;
}): Promise<Response> {
  const violations = validateDocumentFilters(
    platformRegistry,
    input.resolved.document,
    input.release ?? { types: {}, properties: {} },
  );
  if (violations.length)
    throw new ProblemError('invalid_request', {
      errors: violations.map(({ pointer, code }) => ({
        pointer,
        code: code === 'limit' ? 'out_of_range' : 'unsupported',
      })),
    });
  // The probes already ran; plan once and run what they did not answer in one call.
  const plan = (() => {
    try {
      return planReads(platformRegistry, input.resolved.document, {
        subject: input.subject,
        account: input.account,
        ...(input.context ? { context: input.context } : {}),
        ...(input.continuation ? { continuation: input.continuation } : {}),
      });
    } catch (error) {
      if (error instanceof PageContinuationError)
        reject([{ pointer: `/continuation/${error.field}`, code: 'invalid_format' }]);
      if (error instanceof PageReadLimitError) reject([{ pointer: '/reads', code: 'out_of_range' }]);
      throw error;
    }
  })();
  if (
    input.continuation &&
    input.continuationOnlyLists &&
    plan.reads[plan.nodes[input.continuation.node]!]?.kind !== 'search' &&
    plan.reads[plan.nodes[input.continuation.node]!]?.kind !== 'members'
  )
    reject([{ pointer: '/continuation', code: 'unsupported' }]);
  if (Object.values(plan.reads).reduce((cost, read) => cost + readCost(read), 0) > MAX_PAGE_COST)
    reject([{ pointer: '/reads', code: 'out_of_range' }]);
  const observed = new Map(input.probes);
  const continuedKey = input.continuation ? plan.nodes[input.continuation.node] : undefined;
  for (const [readKey, descriptor] of Object.entries(plan.reads)) {
    const key = canonicalize(descriptor)!;
    if (
      continuedKey &&
      readKey !== continuedKey &&
      (descriptor.kind === 'links' ||
        descriptor.kind === 'relations' ||
        descriptor.kind === 'members' ||
        descriptor.kind === 'search' ||
        descriptor.kind === 'subjectThreads')
    ) {
      observed.set(key, { status: 204, body: {} });
      continue;
    }
    if (
      input.context?.population.kind === 'realm' &&
      (descriptor.kind === 'collections' ||
        descriptor.kind === 'reactions' ||
        descriptor.kind === 'search' ||
        descriptor.kind === 'members')
    )
      observed.set(canonicalize(descriptor)!, { status: 503, body: { code: 'dependency_unavailable' } });
  }
  const context = input.context ? { context: input.context.id } : {};
  const observation = observed.get(canonicalize({ kind: 'subject', id: input.subject, ...context })!);
  const subjectBody = observation?.status === 200 && isRecord(observation.body) ? observation.body.subject : undefined;
  const properties =
    isRecord(subjectBody) && isRecord(subjectBody.statements) ? Object.keys(subjectBody.statements) : [];
  const documents = quotationPageDocuments(
    documentRead(input.resolved.document, input.subject, properties, input.context?.id),
    input.release,
    input.subjectType,
    input.subject,
    properties,
    input.context?.id,
  );
  const incoming = new Request(input.request.url, { headers: input.request.headers, signal: input.request.signal });
  const forwarded = mergedSession(
    input.session.ring,
    input.session.scope,
    incoming.headers.get(SESSION_HEADER),
    input.probeSession,
  );
  if (forwarded !== null) incoming.headers.set(SESSION_HEADER, forwarded);
  let page;
  let releaseGuard: (() => void) | undefined;
  try {
    releaseGuard = input.finalGuard ? input.budget.reserve(1, 1) : undefined;
    page = await readPage({
      dispatch: input.dispatch,
      resolveBuiltin: input.resolveBuiltin,
      incoming,
      reads: plan.reads,
      session: input.session,
      observed,
      budget: input.budget,
      ...(documents ? { documents } : {}),
      ...(input.languages === undefined ? {} : { languages: input.languages }),
    });
  } catch (error) {
    if (error instanceof PageReadError) reject(error.errors);
    throw error;
  } finally {
    releaseGuard?.();
  }
  let readSession = mergedSession(input.session.ring, input.session.scope, input.probeSession, page.session);

  if (input.finalGuard) {
    const guarded = await input.finalGuard(readSession);
    readSession = mergedSession(input.session.ring, input.session.scope, readSession, guarded);
  }
  const reads: Record<string, ReadResult> = {};
  for (const [key, descriptor] of Object.entries(plan.reads)) {
    let result = page.results[key];
    if (
      result?.status === 200 &&
      descriptor.kind === 'subject' &&
      descriptor.id === input.subject &&
      isRecord(result.body)
    )
      result = { ...result, body: { ...result.body, documents: page.documents } };
    if (!result) throw new Error('Page read did not return a result');
    if (descriptor.kind === 'subject' && descriptor.id === input.subject && result.status !== 200) {
      return respond(result.status, result.body, readSession, true);
    }
    // A subject page without an active verified account must not name an account through its subject read.
    reads[key] =
      input.account === null &&
      descriptor.kind === 'subject' &&
      descriptor.id === input.subject &&
      isRecord(result.body)
        ? { ...result, body: { ...result.body, account: null } }
        : result;
  }

  const catalogueViewer = input.viewer ? await input.viewer() : undefined;
  const subjectViewer =
    catalogueViewer === undefined && input.subject !== null
      ? input.actor.kind === 'account'
        ? { kind: 'account' as const, account: input.actor.accountId }
        : { kind: 'anonymous' as const }
      : undefined;
  let viewerEnvelope: ReturnType<typeof pageViewerActions> | undefined;
  if (input.subject) {
    const composed = Object.entries(plan.reads).find(
      ([, descriptor]) => descriptor.kind === 'subject' && descriptor.id === input.subject,
    );
    const composedBody = composed ? reads[composed[0]] : undefined;
    const type =
      composedBody?.status === 200 &&
      isRecord(composedBody.body) &&
      isRecord(composedBody.body.subject) &&
      typeof composedBody.body.subject.type === 'string'
        ? composedBody.body.subject.type
        : undefined;
    if (type && !quotationTypeAdmitted(input.release, input.subjectType)) {
      try {
        input.budget.charge(1);
        const headers = new Headers(incoming.headers);
        headers.set('content-type', 'application/json');
        if (readSession !== null) headers.set(SESSION_HEADER, readSession);
        const viewerResponse = await input.dispatch(
          new Request(new URL('/v1/viewerActions', input.request.url), {
            method: 'POST',
            headers,
            body: JSON.stringify({ resources: [{ type, id: input.subject }] }),
            signal: input.request.signal,
          }),
        );
        const text = await viewerResponse.text();
        viewerEnvelope = pageViewerActions(type, input.subject, {
          status: viewerResponse.status,
          body: text === '' ? null : (JSON.parse(text) as unknown),
        });
        readSession = mergedSession(
          input.session.ring,
          input.session.scope,
          readSession,
          viewerResponse.headers.get(SESSION_HEADER),
        );
      } catch (error) {
        if (error instanceof PageReadError || error instanceof SyntaxError)
          viewerEnvelope = pageViewerActions(type, input.subject, { status: 503, body: null });
        else throw error;
      }
    }
  }

  const quotationAuthority =
    input.subject !== null && quotationTypeAdmitted(input.release, input.subjectType)
      ? await readQuotationPageAuthority({
          pool: input.pool,
          access: input.access,
          actor: input.actor,
          deadline: input.deadline,
        })
      : null;

  return respond(
    200,
    {
      ...(input.subject === null ? {} : { subject: input.subject }),
      ...(input.account === null ? {} : { account: input.account.id }),
      ...(input.context ? { context: input.context } : {}),
      ...(input.continuation ? { continuation: input.continuation } : {}),
      profile: input.digest,
      ...(input.draft ? { draft: input.draft } : {}),
      template: { scope: input.resolved.scope, key: input.resolved.key },
      document: input.resolved.document,
      ...(input.views === null ? {} : { views: input.views }),
      ...(input.catalogue ? { catalogue: input.catalogue } : {}),
      ...(catalogueViewer ? { viewer: catalogueViewer } : {}),
      ...(subjectViewer ? { viewer: subjectViewer } : {}),
      ...(quotationAuthority ? { viewer: quotationAuthority.viewer } : {}),
      reads,
      ...(input.overlay ? { meanings: input.overlay.meanings, unavailable: input.overlay.unavailable } : {}),
      ...(quotationAuthority
        ? { actions: quotationAuthority.actions }
        : viewerEnvelope
          ? { actions: viewerEnvelope.actions }
          : {}),
    },
    readSession,
    true,
  );
}
