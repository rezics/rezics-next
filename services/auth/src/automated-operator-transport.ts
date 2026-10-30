import type { SessionProof } from '@rezics/auth-contract';
import type { AuthService } from './index.ts';
import { readJsonObject, TransportDenied } from './account-operations-transport.ts';
import { automatedCallerMatches } from './automated-account-transport.ts';

export type AutomatedCreationOperator = Readonly<{
  id: string;
  kind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
}>;
/** Auth-local declaration for the native trusted port, never browser authority. */
export interface AutomatedOperatorAccess {
  readAutomatedCreationOperator(input: {
    human: SessionProof;
    operatorAccountId: string;
    deadline: number;
  }): Promise<AutomatedCreationOperator | null>;
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
      if (!fields(body, ['operatorAccountId']) || !id(body.operatorAccountId)) return denied(400);
      const operatorAccountId = body.operatorAccountId;
      const deadline = Date.now() + 3000;
      const result = await service.internal.withFreshHuman(
        { headers: request.headers, fresh: false },
        async (human) => {
          if (!automatedCallerMatches(human, human.account_id)) throw new TransportDenied(403);
          return automatedCreationOperator(
            await access.readAutomatedCreationOperator({ human, operatorAccountId, deadline }),
            operatorAccountId,
          );
        },
      );
      return response(result);
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      return denied(typeof status === 'number' && [400, 401, 403, 409, 413, 415, 503].includes(status) ? status : 503);
    }
  };
}
