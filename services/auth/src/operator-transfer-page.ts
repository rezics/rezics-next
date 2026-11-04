import { managementOperationProfile, type SessionProof } from '@rezics/auth-contract';
import type { AuthService } from './index.ts';
import { readJsonObject, TransportDenied } from './account-operations-transport.ts';

export type OperatorTransferHandoff = {
  version: 1;
  previous: { operatorAccountId: string; subjectAccountId: string; reservationId: string };
  expectedVersion: string;
  operatorAccountId: string;
  sourceOperationKey: string;
};
export type OperatorTransferRelation = {
  previous: { operatorAccountId: string; subjectAccountId: string; reservationId: string };
  expectedVersion: string;
};
export type OperatorTransferPageInput =
  | { kind: 'readiness' }
  | { kind: 'source'; subjectAccountId: string }
  | { kind: 'destination'; request: OperatorTransferHandoff };
type NativeInput = Exclude<OperatorTransferPageInput, { kind: 'readiness' }>;
export type OperatorTransferPageRead =
  | { kind: 'source'; relation: OperatorTransferRelation; action: 'allowed' }
  | { kind: 'destination'; destinationAccountId: string; action: 'allowed' | 'denied' }
  | { kind: 'missing' | 'refused' | 'changed' | 'unavailable' };
export type OperatorTransferPageAccess = {
  readOperatorTransferPage(token: string, input: NativeInput, context: { deadline: number }): Promise<OperatorTransferPageRead>;
};
export type OperatorTransferPageResponse = {
  viewer:
    | { kind: 'ready' }
    | { kind: 'authentication-required'; continuation: 'operator-transfer' }
    | { kind: 'signed-out' }
    | { kind: 'refused' };
  review: OperatorTransferPageRead | { kind: 'readiness' };
};

export const OPERATOR_TRANSFER_PAGE_PATH = '/account-management/operators/transfer-review';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const response = (body: OperatorTransferPageResponse, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  });
const refused = (status = 400) =>
  response({ viewer: { kind: 'refused' }, review: { kind: 'refused' } }, status);

function fields(value: Record<string, unknown>, names: string[]) {
  return Object.keys(value).sort().join(',') === [...names].sort().join(',');
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0020\u007f]/.test(value);
}
function handoff(value: unknown): value is OperatorTransferHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const previous = item.previous;
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return false;
  const relation = previous as Record<string, unknown>;
  return (
    fields(item, ['version', 'previous', 'expectedVersion', 'operatorAccountId', 'sourceOperationKey']) &&
    item.version === 1 &&
    fields(relation, ['operatorAccountId', 'subjectAccountId', 'reservationId']) &&
    typeof relation.operatorAccountId === 'string' &&
    uuid.test(relation.operatorAccountId) &&
    typeof relation.subjectAccountId === 'string' &&
    uuid.test(relation.subjectAccountId) &&
    typeof relation.reservationId === 'string' &&
    uuid.test(relation.reservationId) &&
    typeof item.operatorAccountId === 'string' &&
    uuid.test(item.operatorAccountId) &&
    item.operatorAccountId !== relation.operatorAccountId &&
    item.operatorAccountId !== relation.subjectAccountId &&
    typeof item.expectedVersion === 'string' &&
    /^(0|[1-9][0-9]*)$/.test(item.expectedVersion) &&
    text(item.sourceOperationKey, 128)
  );
}
function sourceRelation(value: unknown, subjectAccountId: string): OperatorTransferPageRead | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const relation = result.relation;
  if (!relation || typeof relation !== 'object' || Array.isArray(relation)) return null;
  const state = relation as Record<string, unknown>;
  const previous = state.previous;
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return null;
  const row = previous as Record<string, unknown>;
  if (
    result.kind !== 'source' ||
    result.action !== 'allowed' ||
    !fields(state, ['previous', 'expectedVersion']) ||
    !fields(row, ['operatorAccountId', 'subjectAccountId', 'reservationId']) ||
    row.subjectAccountId !== subjectAccountId ||
    typeof row.operatorAccountId !== 'string' ||
    !uuid.test(row.operatorAccountId) ||
    typeof row.reservationId !== 'string' ||
    !uuid.test(row.reservationId) ||
    typeof state.expectedVersion !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(state.expectedVersion)
  )
    return null;
  return {
    kind: 'source',
    action: 'allowed',
    relation: {
      previous: {
        operatorAccountId: row.operatorAccountId,
        subjectAccountId,
        reservationId: row.reservationId,
      },
      expectedVersion: state.expectedVersion,
    },
  };
}
function projectRead(input: NativeInput, value: unknown): OperatorTransferPageRead {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'unavailable' };
  const result = value as Record<string, unknown>;
  if (result.kind === 'source' && input.kind === 'source')
    return sourceRelation(value, input.subjectAccountId) ?? { kind: 'unavailable' };
  if (
    result.kind === 'destination' &&
    input.kind === 'destination' &&
    result.destinationAccountId === input.request.operatorAccountId &&
    (result.action === 'allowed' || result.action === 'denied')
  )
    return { kind: 'destination', destinationAccountId: input.request.operatorAccountId, action: result.action };
  if (['missing', 'refused', 'changed', 'unavailable'].includes(String(result.kind)) && Object.keys(result).length === 1)
    return { kind: result.kind as 'missing' | 'refused' | 'changed' | 'unavailable' };
  return { kind: 'unavailable' };
}
function transferProfile(proof: SessionProof) {
  const profile = managementOperationProfile('transfer');
  return (
    proof.client_id === profile.client_id &&
    proof.scope.length === 1 &&
    proof.scope[0] === profile.scope[0] &&
    proof.amr.length === 1 &&
    (proof.amr[0] === 'pwd' || proof.amr[0] === 'pop')
  );
}
function errorStatus(error: unknown) {
  return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
    ? error.status
    : undefined;
}
function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** One closed, same-origin read for the selected side. It never approves or executes a transfer. */
export function operatorTransferPageTransport(
  service: AuthService,
  fallback: (request: Request) => Promise<Response>,
  access: OperatorTransferPageAccess | undefined,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== OPERATOR_TRANSFER_PAGE_PATH) return fallback(request);
    if (
      request.method !== 'POST' ||
      url.search ||
      request.headers.has('authorization') ||
      request.headers.get('origin') !== new URL(service.verifier.issuer).origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
    )
      return refused();

    let input: OperatorTransferPageInput;
    try {
      const body = await readJsonObject(request);
      if (body.kind === 'readiness' && fields(body, ['kind'])) input = { kind: 'readiness' };
      else if (
        body.kind === 'source' &&
        fields(body, ['kind', 'subjectAccountId']) &&
        typeof body.subjectAccountId === 'string' &&
        uuid.test(body.subjectAccountId)
      )
        input = { kind: 'source', subjectAccountId: body.subjectAccountId };
      else if (body.kind === 'destination' && fields(body, ['kind', 'request']) && handoff(body.request))
        input = { kind: 'destination', request: body.request };
      else return refused();
    } catch (error) {
      const status = errorStatus(error);
      return refused(status === 413 ? 413 : 400);
    }

    try {
      const result = await service.internal.withFreshHuman(
        { headers: request.headers, fresh: false },
        async (human) => {
          if (!transferProfile(human))
            return {
              viewer: { kind: 'authentication-required' as const, continuation: 'operator-transfer' as const },
              review: { kind: 'unavailable' as const },
            };
          const deadline = Date.now() + 10_000;
          let review: OperatorTransferPageResponse['review'];
          if (input.kind === 'readiness') review = { kind: 'readiness' };
          else {
            // This token is server-only. Rechecking the same proof after native I/O
            // keeps a replaced session, profile, floor or actor from receiving advice.
            const token = await service.internal.accessTokenForProof(human);
            review = access
              ? projectRead(input, await access.readOperatorTransferPage(token, input, { deadline }))
              : { kind: 'unavailable' };
            await service.internal.accessTokenForProof(human);
            if (Date.now() >= deadline) review = { kind: 'unavailable' };
          }
          return { viewer: { kind: 'ready' as const }, review };
        },
      );
      return response(result);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 401 && errorCode(error) === 'step_up_required')
        return response({
          viewer: { kind: 'authentication-required', continuation: 'operator-transfer' },
          review: { kind: 'unavailable' },
        });
      if (status === 401)
        return response({ viewer: { kind: 'signed-out' }, review: { kind: 'unavailable' } });
      if (status === 403)
        return response({ viewer: { kind: 'refused' }, review: { kind: 'refused' } });
      return response({ viewer: { kind: 'ready' }, review: { kind: 'unavailable' } }, 503);
    }
  };
}
