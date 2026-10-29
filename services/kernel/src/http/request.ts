import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { parseItem } from 'structured-headers';
import { ProblemError } from './problem.ts';
import { ANONYMOUS_PRINCIPAL_ID, normalizeCommandKey, type CommandPrincipal } from '../command/command.ts';
import type { ActionCatalogue, Actor } from '../request/access.ts';
import { anchorRoute, derivedId } from '../route/route.ts';
import { kernelWriteRateFor } from './write-rate-routes.ts';

export const SESSION_HEADER = 'rezics-session-token';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

export function idempotencyKeyOf(header: string | null | undefined, principal?: CommandPrincipal): string {
  if (typeof header !== 'string')
    throw new ProblemError('invalid_request', { detail: 'Idempotency-Key must be a structured field string.' });

  let value: unknown;
  try {
    [value] = parseItem(header);
  } catch {
    throw new ProblemError('invalid_request', { detail: 'Idempotency-Key must be a structured field string.' });
  }
  if (typeof value !== 'string' || value.length < 1 || value.length > 255)
    throw new ProblemError('invalid_request', { detail: 'Idempotency-Key must be a string of 1 to 255 characters.' });
  try {
    return principal ? normalizeCommandKey(principal, value) : value;
  } catch {
    throw new ProblemError('invalid_request', {
      detail: 'Anonymous commands require a client-generated UUIDv4 Idempotency-Key.',
    });
  }
}

export function requestDigest(operation: string, actor: Actor, body: unknown): Uint8Array {
  const canonical = canonicalize({
    operation,
    client_id: actor.kind === 'anonymous' ? null : actor.clientId,
    requested_by: actor.kind === 'anonymous' ? null : actor.requestedBy,
    body,
  });
  if (canonical === undefined) throw new TypeError('Request body must be canonical JSON');
  return createHash('sha256').update(canonical, 'utf8').digest();
}

/** Stable tuple home under the server-owned route key; grants no authorization. */
export function anonymousCommandTarget(
  routeKey: Uint8Array,
  operation: string,
  key: string,
): { route: number; id: string } {
  const name = JSON.stringify([
    'anonymous',
    ANONYMOUS_PRINCIPAL_ID,
    operation,
    normalizeCommandKey({ kind: 'anonymous', id: ANONYMOUS_PRINCIPAL_ID }, key),
  ]);
  const route = anchorRoute(routeKey, name);
  return { route, id: derivedId(ANONYMOUS_PRINCIPAL_ID, name, route) };
}

/** The caller owns all normalized effect fields in semantic; fresh proof is excluded. */
export function anonymousRequestDigest(operation: string, input: { semantic: unknown; abuse?: unknown }): Uint8Array {
  return requestDigest(operation, { kind: 'anonymous' }, input.semantic);
}

const ACTION_PATTERN = /^[a-z][a-z_]*:[a-z][a-z_]*$/;
const OPERATION_PATTERN = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_.-]*$/;

export type MountedRoute = {
  method: string;
  path: string;
  hooks?: { detail?: unknown };
};

type RouteApp = {
  routes: readonly MountedRoute[];
  '~map'?: { [method: string]: Record<string, unknown> | undefined };
  '~config'?: { strictPath?: boolean };
};

type RouteDeclaration = {
  action: string;
  anonymous: boolean;
  replay?: 'self-account-read';
  resourceTypes?: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameResourceTypes(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  const orderedLeft = [...left].sort();
  const orderedRight = [...right].sort();
  return orderedLeft.every((type, index) => type === orderedRight[index]);
}

function resourceTypesOf(route: MountedRoute, detail: Record<string, unknown>): readonly string[] | undefined {
  const value = detail['x-resource-types'];
  if (value === undefined) return undefined;
  const label = `${route.method.toUpperCase()} ${route.path}`;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((type) => typeof type !== 'string' || !RESOURCE_TYPE_PATTERN.test(type)) ||
    new Set(value).size !== value.length
  )
    throw new Error(`${label}: x-resource-types must be a non-empty list of distinct resource type names`);
  return Object.freeze([...value]);
}

function declaration(route: MountedRoute): RouteDeclaration {
  const label = `${route.method.toUpperCase()} ${route.path}`;
  const detail = isRecord(route.hooks?.detail) ? route.hooks.detail : {};
  const action = actionLabelOfMountedRoute(route);

  const operationId = detail.operationId;
  if (typeof operationId !== 'string' || !OPERATION_PATTERN.test(operationId))
    throw new Error(`${label}: routes declare operationId as <resource>.<verb>`);

  const security = detail.security;
  if (!Array.isArray(security) || security.length === 0) throw new Error(`${label}: routes declare security`);
  const replay = detail['x-replay-authorization'];
  if (replay !== undefined && replay !== 'self-account-read')
    throw new Error(`${label}: unsupported x-replay-authorization`);

  const resourceTypes = resourceTypesOf(route, detail);
  return {
    action,
    anonymous: security.some((requirement) => isRecord(requirement) && Object.keys(requirement).length === 0),
    ...(replay === undefined ? {} : { replay }),
    ...(resourceTypes === undefined ? {} : { resourceTypes }),
  };
}

const actionCatalogues = new WeakMap<object, ActionCatalogue>();

/** Derives the configured action set from the routes mounted on an application. */
export function actionCatalogue(app: RouteApp): ActionCatalogue {
  const mounted = mountedCatalogues.get(app);
  if (mounted) return actionCatalogue(mounted);
  const cached = actionCatalogues.get(app);
  if (cached) return cached;
  const catalogue = new Map<
    string,
    { anonymous: boolean; replay?: 'self-account-read'; 'x-resource-types'?: readonly string[] }
  >();
  for (const route of app.routes) {
    const detail = isRecord(route.hooks?.detail) ? route.hooks.detail : {};
    if (detail.hide === true) continue;

    const { action, anonymous, replay, resourceTypes } = declaration(route);
    const previous = catalogue.get(action);
    const label = `${route.method.toUpperCase()} ${route.path}`;
    if (previous && previous.anonymous !== anonymous)
      throw new Error(`${label}: ${action} is declared with different security`);
    if (previous && previous.replay !== replay)
      throw new Error(`${label}: ${action} is declared with different replay authorization`);
    if (previous && !sameResourceTypes(previous['x-resource-types'], resourceTypes))
      throw new Error(`${label}: ${action} is declared with different resource types`);
    catalogue.set(action, {
      anonymous,
      ...(replay === undefined ? {} : { replay }),
      ...(resourceTypes === undefined ? {} : { 'x-resource-types': resourceTypes }),
    });
  }
  // Account updates authorize an automated account through management of its operator.
  if (catalogue.has('account:update') && !catalogue.has('account:manage'))
    catalogue.set('account:manage', { anonymous: false });
  // Unsealed applications may still mount routes. Cache only the final snapshot.
  if (app instanceof MountedRouteCatalogue) actionCatalogues.set(app, catalogue);
  return catalogue;
}

/** A snapshot of server declarations, indexed by native method and matched template.
 * Construct only after composition; Elysia's routes getter composes hook views.
 * Request paths are never matched here: Elysia has already selected the route.
 */
export class MountedRouteCatalogue {
  readonly routes: readonly MountedRoute[];
  readonly #index = new Map<string, MountedRoute>();

  constructor(routes: readonly MountedRoute[], app?: RouteApp) {
    this.routes = routes.map((route) => {
      const detail = isRecord(route.hooks?.detail) ? { ...route.hooks.detail } : {};
      const composedRate = app && kernelWriteRateFor(app, route);
      if (detail['x-rate-limit'] === undefined && composedRate) detail['x-rate-limit'] = composedRate;
      const rate = detail['x-rate-limit'];
      if (isRecord(rate)) detail['x-rate-limit'] = Object.freeze({ ...rate });
      const mounted = Object.freeze({
        method: route.method.toUpperCase(),
        path: route.path,
        hooks: Object.freeze({ detail: Object.freeze(detail) }),
      });
      this.#index.set(`${mounted.method} ${mounted.path}`, mounted);
      return mounted;
    });
    Object.freeze(this.routes);
    // Native static handlers omit context.route. Index their actual router identities,
    // including encoded aliases and Elysia's non-strict trailing-slash aliases, once.
    const native = app?.['~map'];
    if (native) {
      const identities = new Map<unknown, MountedRoute>();
      for (const route of this.routes) {
        const method = route.method === 'ALL' ? '*' : route.method;
        const identity = native[method]?.[route.path];
        if (identity !== undefined) identities.set(identity, route);
      }
      for (const [method, paths] of Object.entries(native)) {
        for (const [path, identity] of Object.entries(paths ?? {})) {
          const route = identities.get(identity);
          if (!route) continue;
          this.#index.set(`${method} ${path}`, route);
          const loose = `${path}/`;
          if (!app?.['~config']?.strictPath && !native[method]?.[loose]) this.#index.set(`${method} ${loose}`, route);
        }
      }
    }
  }

  find(request: Request, matchedTemplate?: string): MountedRoute | undefined {
    // Static native handlers may omit route; their pathname is already the literal template.
    const path = matchedTemplate ?? new URL(request.url).pathname;
    return (
      this.#index.get(`${request.method.toUpperCase()} ${path}`) ??
      this.#index.get(`ALL ${path}`) ??
      this.#index.get(`* ${path}`)
    );
  }
}

const mountedCatalogues = new WeakMap<object, MountedRouteCatalogue>();

/** App instances and standalone stage route arrays have independent catalogue lifetimes. */
export function mountedRouteCatalogue(
  app: RouteApp | readonly MountedRoute[],
  routes?: readonly MountedRoute[],
): MountedRouteCatalogue {
  let catalogue = mountedCatalogues.get(app);
  if (!catalogue) {
    catalogue = new MountedRouteCatalogue(
      routes ?? (Array.isArray(app) ? app : (app as RouteApp).routes),
      Array.isArray(app) ? undefined : (app as RouteApp),
    );
    mountedCatalogues.set(app, catalogue);
  }
  return catalogue;
}

/** The action label is also available for errors before authorization is initialized. */
export function actionLabelOfMountedRoute(route: MountedRoute | undefined): string {
  if (!route) throw new Error('No matching mounted route declaration');
  const detail = isRecord(route.hooks?.detail) ? route.hooks.detail : {};
  const action = detail['x-action'];
  if (typeof action !== 'string' || !ACTION_PATTERN.test(action))
    throw new Error(`${route.method.toUpperCase()} ${route.path}: routes declare x-action as <resource>:<verb>`);
  return action;
}

export function actionOfMountedRoute(route: MountedRoute | undefined): string {
  if (!route) throw new Error('No matching mounted route declaration');
  return declaration(route).action;
}

/** Finds and validates Elysia's mounted route, never routing a parameterized URL again. */
export function actionForRequest(app: RouteApp, request: Request, routePath?: string): string {
  return actionOfMountedRoute(mountedRouteCatalogue(app).find(request, routePath));
}
