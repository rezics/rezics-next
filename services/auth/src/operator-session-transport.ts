import { isManagementOperation } from '@rezics/auth-contract';
import type { AuthService } from './index.ts';
import type { AccountOperation, createAccountWorkflows } from './workflows.ts';
import { managementCallerMatches } from './auth-management-client.ts';
import { readJsonObject, TransportDenied, type AccountOperationAccess } from './account-operations-transport.ts';

/** Immediate HTTP composition only: the native workflow owns opening and Auth
 * owns session issuance. Neither cookies nor SessionProof enter DBOS payloads. */
export function operatorSessionTransport(
  service: AuthService,
  workflows: Pick<ReturnType<typeof createAccountWorkflows>, 'openOperatorSession'>,
  fallback: (request: Request) => Promise<Response>,
  access: AccountOperationAccess | undefined,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== '/operator-sessions/open') return fallback(request);
    const denied = (status: number, error = 'account_operation_denied') =>
      Response.json(
        { error, effect_status: status === 503 ? 'unknown' : 'not_applied' },
        {
          status,
          headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
        },
      );
    if (!access) return denied(503);
    if (
      request.method !== 'POST' ||
      url.search ||
      request.headers.get('origin') !== new URL(service.verifier.issuer).origin ||
      request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' ||
      request.headers.has('authorization') ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return denied(400);
    try {
      const body = await readJsonObject(request);
      const operation = body.operation;
      if (
        Object.keys(body).sort().join(',') !== 'accountId,operation,operationKey,reference' ||
        ![body.accountId, body.operationKey, body.reference].every(
          (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096,
        ) ||
        !isManagementOperation(operation) ||
        operation.kind !== 'opening'
      )
        return denied(400);
      const authorization = body.reference as string;
      const context = access.context();
      await service.internal.withFreshHuman({ headers: request.headers }, async (proof) => {
        if (!managementCallerMatches(proof, body.accountId, operation)) throw new TransportDenied(403);
        await access.resolveForCaller(
          await service.internal.accessTokenForProof(proof),
          authorization,
          { ...operation, authorization } as AccountOperation,
          context,
        );
      });
      // One call, no replay or mutation-result parser. Preserve Auth's actual
      // closed SessionProof and every genuine Set-Cookie header verbatim.
      return await workflows.openOperatorSession({
        key: body.operationKey as string,
        authorization,
        operatorAccountId: operation.operatorAccountId,
        subjectAccountId: operation.subjectAccountId,
        headers: request.headers,
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'step_up_required')
        return denied(401, 'step_up_required');
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      return denied(typeof status === 'number' && [400, 401, 403, 409, 413, 415].includes(status) ? status : 503);
    }
  };
}
