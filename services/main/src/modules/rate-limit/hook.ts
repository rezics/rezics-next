import { Elysia, ParseError, ValidationError, status, type Context } from 'elysia';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AccountAssertionDenied, verifyRequestAccount } from '../account/verify-assertion.ts';
import { withFusekiReadWait } from '../../infrastructure/fuseki.ts';
import {
  rateLimitFamily,
  type Budgets,
  type PrincipalClass,
  type RateLimitFamily,
} from './budgets.ts';
import { anonymousIdentity, type RateLimitOptions, type RateLimitStore } from './store.ts';
import { PrincipalBudgetCache } from './principal-cache.ts';
import { problem } from '../../routes/problems.ts';
import { legacyFailureResponse } from '../problem.ts';

export interface MainRateLimit {
  store: RateLimitStore;
  options: RateLimitOptions;
  budgets: Budgets;
}

export function rateLimitHook(
  account: Pick<AccountAssertionVerifier, 'verify'>,
  limit?: MainRateLimit,
) {
  const cache = new PrincipalBudgetCache();
  const charged = new WeakSet<Request>();
  const pageResolution = (request: Request) =>
    (request.method === 'GET' || request.method === 'HEAD') &&
    new URL(request.url).pathname === '/v1/addresses/resolve';
  const consume = async (
    request: Request,
    peer: string | undefined,
    family: RateLimitFamily,
    set: Context['set'],
  ) => {
    if (!limit) return;
    if (pageResolution(request)) {
      if (charged.has(request)) return;
      charged.add(request);
    }
    const anonymous = !request.headers.has('authorization');
    try {
      let principalClass: PrincipalClass = 'anonymous';
      let identity = anonymousIdentity(request, peer, limit.options);
      // Intake capacity is independent of Account availability and bearer
      // validity. Public intake and signed provider handlers own their proof;
      // this boundary always attributes their capacity to the trusted peer IP.
      const independent =
        family === 'report' || family === 'correspondence' || family === 'provider';
      if (!anonymous && !independent) {
        const attribution = await withFusekiReadWait(request.signal, signal => cache.resolve(
          request.headers.get('authorization')!,
          () => verifyRequestAccount(account, request, []),
          (principal) => limit.store.classify(principal),
          signal,
        ));
        identity = attribution.identity;
        principalClass = attribution.principalClass;
      }
      const decision = await limit.store.consume(
        identity,
        family,
        limit.budgets[principalClass][family],
      );
      if (!decision.allowed) {
        set.headers['content-type'] = 'application/problem+json';
        set.headers['retry-after'] = String(decision.retryAfter);
        set.headers['cache-control'] = 'no-store';
        return status(429, {
          type: 'about:blank',
          status: 429,
          code: 'rate_limited',
          title: 'Request budget exhausted',
          family,
        });
      }
    } catch (error) {
      const code = error instanceof AccountAssertionDenied ? 401 : 503;
      set.headers['content-type'] = 'application/problem+json';
      set.headers['cache-control'] = 'no-store';
      if (code === 503) set.headers['retry-after'] = '5';
      return status(code, {
        type: 'about:blank',
        status: code,
        code: code === 401 ? 'account_assertion_denied' : 'rate_limit_unavailable',
        title: code === 401 ? 'Account assertion refused' : 'Request budget unavailable',
      });
    }
  };
  return new Elysia({ name: 'main-rate-limit-v1' })
    .onStart(() => {
      limit?.store.startExpirySweep?.();
    })
    .onStop(async () => {
      await limit?.store.stopExpirySweep?.();
    })
    .onBeforeHandle('global', async function enforceRateLimit({ request, server, set }) {
      // Embedded route fixtures may omit deployment dependencies. The HTTP
      // composition root always supplies the store; no runtime fail-open switch.
      if (!limit) return;
      const family = rateLimitFamily(request.method, new URL(request.url).pathname);
      if (family === null) return;
      if (family === undefined) {
        set.headers['content-type'] = 'application/problem+json';
        set.headers['cache-control'] = 'no-store';
        set.headers['retry-after'] = '5';
        return status(503, {
          type: 'about:blank',
          status: 503,
          code: 'rate_limit_unclassified',
          title: 'Request budget policy unavailable',
        });
      }
      // Page navigation must first establish a miss. Batch enumeration,
      // availability and revision inventory retain their pre-read budgets.
      if (pageResolution(request)) return;
      // Native validators inspect the status body, so pass the Problem object
      // directly while preserving non-success statuses in Eden's route union.
      return consume(request, server?.requestIP(request)?.address, family, set);
    })
    .mapResponse('global', async ({ request, server, responseValue, set }) => {
      if (!pageResolution(request)) return;
      const status = responseValue instanceof Response ? responseValue.status : set.status;
      if (status !== 400 && status !== 404 && status !== 422) return;
      const refusal = await consume(request, server?.requestIP(request)?.address, 'address', set);
      return refusal ? legacyFailureResponse(refusal, set) : undefined;
    })
    .onError('global', async ({ request, server, error, set }) => {
      // Validation precedes beforeHandle. Cover standalone route plugins too;
      // the composition root's own 400 is charged by mapResponse above.
      if (
        !pageResolution(request) ||
        !(error instanceof ValidationError || error instanceof ParseError)
      )
        return;
      return (
        (await consume(request, server?.requestIP(request)?.address, 'address', set)) ??
        problem(400, 'invalid_request', 'Request does not match the Work contract')
      );
    });
}
