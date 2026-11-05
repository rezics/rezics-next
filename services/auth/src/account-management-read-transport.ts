import { managementOperationProfile, type SessionProof } from '@rezics/auth-contract';
import type { AuthService } from './index.ts';
import { readJsonObject, TransportDenied, type AccountOperationAccess } from './account-operations-transport.ts';

/** Local closed adapter until generated HTTP bindings include this private read. */
export type OperatorTransferState = {
  previous: { operatorAccountId: string; subjectAccountId: string; reservationId: string };
  expectedVersion: string;
};
export const OPERATOR_RELATION_PATH = '/account-management/operators/relation';
/** Independent native read composition also fits the existing operation ports. */
export type AccountManagementReadAccess = Pick<AccountOperationAccess, 'context' | 'readOperatorTransferState'>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function managementHuman(proof: SessionProof) {
  const profile = managementOperationProfile('transfer');
  return (
    proof.client_id === profile.client_id &&
    proof.scope.length === 1 &&
    proof.scope[0] === profile.scope[0] &&
    proof.amr.length === 1 &&
    (proof.amr[0] === 'pwd' || proof.amr[0] === 'pop')
  );
}
function closedState(value: OperatorTransferState, subjectAccountId: string): OperatorTransferState {
  // Project the trusted result too: never serialize an adapter's extra fields.
  if (
    !value ||
    !value.previous ||
    value.previous.subjectAccountId !== subjectAccountId ||
    !uuid.test(value.previous.operatorAccountId) ||
    !uuid.test(value.previous.reservationId) ||
    value.previous.operatorAccountId === subjectAccountId ||
    typeof value.expectedVersion !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value.expectedVersion)
  )
    throw new TransportDenied(503);
  return {
    previous: {
      operatorAccountId: value.previous.operatorAccountId,
      subjectAccountId,
      reservationId: value.previous.reservationId,
    },
    expectedVersion: value.expectedVersion,
  };
}

/** Same Auth fresh-human proof and Access token path as operation approval.
 * Origin + JSON + same-origin fetch metadata provide the existing CSRF boundary.
 * Source data conveys no approval; absent bindings are always unavailable.
 */
export function accountManagementReadTransport(
  service: AuthService,
  fallback: (request: Request) => Promise<Response>,
  access: AccountManagementReadAccess | undefined,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== OPERATOR_RELATION_PATH) return fallback(request);
    const response = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
      });
    const refused = (status: number) =>
      response(
        {
          error:
            status === 503
              ? 'account_management_read_unavailable'
              : status === 409
                ? 'account_management_read_conflict'
                : 'account_management_read_denied',
        },
        status,
      );
    if (
      request.method !== 'POST' ||
      url.search ||
      request.headers.get('origin') !== new URL(service.verifier.issuer).origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      request.headers.has('authorization') ||
      request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
    )
      return refused(400);
    try {
      const body = await readJsonObject(request);
      if (
        Object.keys(body).join(',') !== 'subjectAccountId' ||
        typeof body.subjectAccountId !== 'string' ||
        !uuid.test(body.subjectAccountId)
      )
        return refused(400);
      if (!access?.readOperatorTransferState) return refused(503);
      const subjectAccountId = body.subjectAccountId;
      const context = access.context();
      const state = await service.internal.withFreshHuman({ headers: request.headers }, async (proof) => {
        if (!managementHuman(proof)) throw new TransportDenied(403);
        const token = await service.internal.accessTokenForProof(proof);
        const result = await access.readOperatorTransferState!(token, { subjectAccountId }, context);
        // This revalidates the SAME source session, account/floor, exact consent
        // and client after native I/O. Its same-profile token stays server-only.
        await service.internal.accessTokenForProof(proof);
        if (!result) throw new TransportDenied(403);
        return closedState(result, subjectAccountId);
      });
      return response(state);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'step_up_required')
        return response({ error: 'step_up_required' }, 401);
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      return refused(typeof status === 'number' && [400, 401, 403, 409, 413].includes(status) ? status : 503);
    }
  };
}
