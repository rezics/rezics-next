import type { SessionProof } from '@rezics/auth-contract';
import type { AuthService } from './index.ts';
import { automatedCallerMatches } from './automated-account-transport.ts';
import { readJsonObject, TransportDenied } from './account-operations-transport.ts';

export type AutomatedCreationOperator = Readonly<{
  id: string;
  kind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
}>;
export type AutomatedCreationPage = Readonly<{
  viewer: { accountId: string };
  readiness: 'authentication-needed' | 'select-operator' | 'review' | 'refused';
  operator: AutomatedCreationOperator | null;
  handleRules: { minLength: 3; maxLength: 64; normalization: 'lowercase'; pattern: '[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]' };
  action: 'authenticate' | 'select-operator' | 'confirm' | 'none';
}>;
/** Local trusted composition; a browser selection never supplies the human. */
export interface AutomatedOperatorAccess {
  readAutomatedCreationPage(input: {
    human: SessionProof;
    operatorAccountId: string | null;
    deadline: number;
  }): Promise<AutomatedCreationPage>;
}

const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.exec(value)?.[0] === value;
function fields(value: Record<string, unknown>, names: string[]) {
  return Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
}
export function automatedCreationOperator(value: unknown, operatorAccountId: string): AutomatedCreationOperator | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TransportDenied(503);
  const row = value as Record<string, unknown>;
  if (
    !fields(row, ['id', 'kind', 'handle', 'displayName']) ||
    row.id !== operatorAccountId ||
    (row.kind !== 'actor' && row.kind !== 'organization') ||
    (row.handle !== null && typeof row.handle !== 'string') ||
    (row.displayName !== null && typeof row.displayName !== 'string')
  )
    throw new TransportDenied(503);
  return { id: operatorAccountId, kind: row.kind, handle: row.handle, displayName: row.displayName };
}

/** Fail closed if a native dependency returns a broader or inconsistent envelope. */
export function automatedCreationPage(
  value: unknown,
  accountId: string,
  operatorAccountId: string | null,
): AutomatedCreationPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TransportDenied(503);
  const page = value as AutomatedCreationPage;
  const rules = {
    minLength: 3,
    maxLength: 64,
    normalization: 'lowercase',
    pattern: '[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]',
  };
  const actions = {
    'authentication-needed': 'authenticate',
    'select-operator': 'select-operator',
    review: 'confirm',
    refused: 'none',
  };
  if (
    !fields(value as Record<string, unknown>, ['viewer', 'readiness', 'operator', 'handleRules', 'action']) ||
    !page.viewer ||
    Object.keys(page.viewer).join(',') !== 'accountId' ||
    page.viewer.accountId !== accountId ||
    !Object.hasOwn(actions, page.readiness) ||
    page.action !== actions[page.readiness] ||
    !page.handleRules ||
    !fields(page.handleRules, Object.keys(rules)) ||
    Object.entries(rules).some(([key, expected]) => page.handleRules[key as keyof typeof rules] !== expected) ||
    (page.readiness === 'select-operator' && operatorAccountId !== null) ||
    (page.readiness === 'refused' && operatorAccountId === null) ||
    (page.readiness !== 'review' && page.operator !== null)
  )
    throw new TransportDenied(503);
  const operator =
    page.readiness === 'review' && operatorAccountId
      ? automatedCreationOperator(page.operator, operatorAccountId)
      : null;
  if (page.readiness === 'review' && !operator) throw new TransportDenied(503);
  return {
    viewer: { accountId },
    readiness: page.readiness,
    operator,
    handleRules: page.handleRules,
    action: page.action,
  };
}

export function automatedOperatorTransport(
  service: AuthService,
  fallback: (request: Request) => Promise<Response>,
  access: AutomatedOperatorAccess | undefined,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== '/account-management/automated/operator') return fallback(request);
    const response = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
      });
    const denied = (status: number) => response({ error: 'automated_operator_denied' }, status);
    if (!access) return denied(503);
    if (
      request.method !== 'POST' ||
      url.search ||
      request.headers.has('authorization') ||
      request.headers.get('origin') !== new URL(service.verifier.issuer).origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
    )
      return denied(400);
    try {
      const body = await readJsonObject(request);
      if (!fields(body, ['operatorAccountId']) || (body.operatorAccountId !== null && !id(body.operatorAccountId)))
        return denied(400);
      const operatorAccountId = body.operatorAccountId;
      const deadline = Date.now() + 3000;
      const result = await service.internal.withFreshHuman(
        { headers: request.headers, fresh: false },
        async (human) => {
          if (human.amr.length !== 1 || !['pwd', 'pop'].includes(human.amr[0]!)) throw new TransportDenied(403);
          const page = automatedCreationPage(
            await access.readAutomatedCreationPage({ human, operatorAccountId, deadline }),
            human.account_id,
            operatorAccountId,
          );
          // An ordinary proof cannot admit target disclosure, even from a malformed native port.
          if (
            (!automatedCallerMatches(human, human.account_id) || Date.now() / 1000 - human.auth_time > 600) &&
            page.readiness !== 'authentication-needed'
          )
            throw new TransportDenied(503);
          // Native observation cannot survive replacement of its genuine proof.
          await service.internal.accessTokenForProof(human);
          if (Date.now() >= deadline) throw new TransportDenied(503);
          return page;
        },
      );
      return response(result);
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      return denied(typeof status === 'number' && [400, 401, 403, 409, 413, 415, 503].includes(status) ? status : 503);
    }
  };
}
