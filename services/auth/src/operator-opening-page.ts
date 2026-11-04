import { managementOperationProfile, type SessionProof } from '@rezics/auth-contract';
import type { AuthService } from './index.ts';
import { readJsonObject, TransportDenied } from './account-operations-transport.ts';

export interface OperatorOpeningPageAccess {
  readOperatorOpeningPage(input: {
    human: SessionProof;
    subjectAccountId: string;
    operatorAccountId: string;
    deadline: number;
  }): Promise<{
    stage: 'current';
    viewer: { accountId: string };
    subject: { id: string; kind: 'actor' };
    operator: { id: string; kind: 'actor' | 'organization' };
    relation: { reservationId: string; version: string };
    disclosure: 'unavailable';
    allowedActions: ['opening'];
  } | null>;
}
export const OPERATOR_OPENING_PAGE_PATH = '/account-management/operators/opening-page';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** One cookie-authenticated page observation. An observation never authorizes submission. */
export function operatorOpeningPageTransport(
  service: AuthService,
  fallback: (request: Request) => Promise<Response>,
  access?: OperatorOpeningPageAccess,
) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== OPERATOR_OPENING_PAGE_PATH) return fallback(request);
    const response = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
      });
    if (
      request.method !== 'POST' ||
      url.search ||
      request.headers.has('authorization') ||
      request.headers.get('origin') !== new URL(service.verifier.issuer).origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
    )
      return response({ stage: 'refused' }, 400);
    try {
      const body = await readJsonObject(request);
      if (
        Object.keys(body).sort().join(',') !== 'operatorAccountId,subjectAccountId' ||
        typeof body.subjectAccountId !== 'string' ||
        !uuid.test(body.subjectAccountId) ||
        typeof body.operatorAccountId !== 'string' ||
        !uuid.test(body.operatorAccountId)
      )
        throw new TransportDenied(400);
      if (!access) return response({ stage: 'unavailable' }, 503);
      const deadline = Date.now() + 10_000;
      const page = await service.internal.withFreshHuman({ headers: request.headers }, async (human) => {
        const profile = managementOperationProfile('opening');
        if (
          human.client_id !== profile.client_id ||
          JSON.stringify(human.scope) !== JSON.stringify(profile.scope) ||
          human.amr.length !== 1 ||
          !['pwd', 'pop'].includes(human.amr[0]!)
        )
          throw new TransportDenied(403);
        const result = await access.readOperatorOpeningPage({
          human,
          subjectAccountId: body.subjectAccountId as string,
          operatorAccountId: body.operatorAccountId as string,
          deadline,
        });
        await service.internal.accessTokenForProof(human);
        if (!result) throw new TransportDenied(403);
        // Closed projection; no port extension can serialize private labels or authority.
        return {
          stage: 'current',
          viewer: { accountId: human.account_id },
          subject: { id: result.subject.id, kind: result.subject.kind },
          operator: { id: result.operator.id, kind: result.operator.kind },
          relation: { reservationId: result.relation.reservationId, version: result.relation.version },
          disclosure: 'unavailable',
          allowedActions: ['opening'],
        };
      });
      return response(page);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'step_up_required')
        return response({ stage: 'step-up' }, 401);
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      if (typeof status === 'number' && [400, 401, 403, 409, 413].includes(status))
        return response({ stage: 'refused' }, status);
      return response({ stage: 'unavailable' }, 503);
    }
  };
}
