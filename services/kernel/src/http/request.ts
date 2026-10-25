import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { parseItem } from 'structured-headers';
import { ProblemError } from './problem.ts';
import type { AccountActor } from '../request/access.ts';
import type { ActionCatalogue } from '../request/access.ts';

export const SESSION_HEADER = 'rezics-session-token';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

export function idempotencyKeyOf(header: string | null | undefined): string {
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
  return value;
}

export function requestDigest(operation: string, actor: AccountActor, body: unknown): Uint8Array {
  const canonical = canonicalize({
    operation,
    client_id: actor.clientId,
    requested_by: actor.requestedBy,
    body,
  });
  if (canonical === undefined) throw new TypeError('Request body must be canonical JSON');
  return createHash('sha256').update(canonical, 'utf8').digest();
}

const ACTION_PATTERN = /^[a-z][a-z_]*:[a-z][a-z_]*$/;
const OPERATION_PATTERN = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;

type Route = {
  method: string;
  path: string;
  hooks?: { detail?: unknown };
};

type RouteApp = { routes: readonly Route[] };

type RouteDeclaration = { action: string; anonymous: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function declaration(route: Route): RouteDeclaration {
  const label = `${route.method.toUpperCase()} ${route.path}`;
  const detail = isRecord(route.hooks?.detail) ? route.hooks.detail : {};
  const action = detail['x-action'];
  if (typeof action !== 'string' || !ACTION_PATTERN.test(action))
    throw new Error(`${label}: routes declare x-action as <resource>:<verb>`);

  const operationId = detail.operationId;
  if (typeof operationId !== 'string' || !OPERATION_PATTERN.test(operationId))
    throw new Error(`${label}: routes declare operationId as <resource>.<verb>`);

  const security = detail.security;
  if (!Array.isArray(security) || security.length === 0) throw new Error(`${label}: routes declare security`);

  return {
    action,
    anonymous: security.some((requirement) => isRecord(requirement) && Object.keys(requirement).length === 0),
  };
}

/** Derives the configured action set from the routes mounted on an application. */
export function actionCatalogue(app: RouteApp): ActionCatalogue {
  const catalogue = new Map<string, { anonymous: boolean }>();
  for (const route of app.routes) {
    const detail = isRecord(route.hooks?.detail) ? route.hooks.detail : {};
    if (detail.hide === true) continue;

    const { action, anonymous } = declaration(route);
    const previous = catalogue.get(action);
    if (previous && previous.anonymous !== anonymous)
      throw new Error(`${route.method.toUpperCase()} ${route.path}: ${action} is declared with different security`);
    catalogue.set(action, { anonymous });
  }
  return catalogue;
}

/** Finds and validates the mounted route that is handling this request. */
export function actionForRequest(app: RouteApp, request: Request, routePath?: string): string {
  const method = request.method.toUpperCase();
  const path = routePath ?? new URL(request.url).pathname;
  const route = app.routes.find(
    (entry) =>
      (entry.method.toUpperCase() === method || entry.method === 'ALL' || entry.method === '*') && entry.path === path,
  );
  if (!route) throw new Error(`${method} ${path}: no matching route declaration`);
  return declaration(route).action;
}
