import { Elysia, ParseError, ValidationError } from 'elysia';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AccountAssertionDenied, verifyRequestAccount } from '../account/verify-assertion.ts';
import {
  rateLimitFamily,
  type Budgets,
  type PrincipalClass,
  type RateLimitFamily,
} from './budgets.ts';
import { anonymousIdentity, type RateLimitOptions, type RateLimitStore } from './store.ts';
import { PrincipalBudgetCache } from './principal-cache.ts';
import { problem } from '../../routes/problems.ts';

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
  const consume = async (request: Request, peer: string | undefined, family: RateLimitFamily) => {
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
        const attribution = await cache.resolve(
          request.headers.get('authorization')!,
          () => verifyRequestAccount(account, request, []),
          (principal) => limit.store.classify(principal),
        );
        identity = attribution.identity;
        principalClass = attribution.principalClass;
      }
      const decision = await limit.store.consume(
        identity,
        family,
        limit.budgets[principalClass][family],
      );
      if (!decision.allowed)
        return Response.json(
          {
            type: 'about:blank',
            status: 429,
            code: 'rate_limited',
            title: 'Request budget exhausted',
            family,
          },
          {
            status: 429,
            headers: {
              'content-type': 'application/problem+json',
              'retry-after': String(decision.retryAfter),
              'cache-control': 'no-store',
            },
          },
        );
    } catch (error) {
      const status = error instanceof AccountAssertionDenied ? 401 : 503;
      return Response.json(
        {
          type: 'about:blank',
          status,
          code: status === 401 ? 'invalid_account_assertion' : 'rate_limit_unavailable',
          title: status === 401 ? 'Account assertion refused' : 'Request budget unavailable',
        },
        {
          status,
          headers: {
            'content-type': 'application/problem+json',
            'cache-control': 'no-store',
            ...(status === 503 ? { 'retry-after': '5' } : {}),
          },
        },
      );
    }
  };
  return new Elysia({ name: 'main-rate-limit-v1' })
    .setup(() => {
      limit?.store.startExpirySweep?.();
    })
    .cleanup(async () => {
      await limit?.store.stopExpirySweep?.();
    })
    .beforeHandle('global', async function enforceRateLimit({ request, server }) {
      // Embedded route fixtures may omit deployment dependencies. The HTTP
      // composition root always supplies the store; no runtime fail-open switch.
      if (!limit) return;
      const family = rateLimitFamily(request.method, new URL(request.url).pathname);
      if (family === null) return;
      if (family === undefined)
        return Response.json(
          {
            type: 'about:blank',
            status: 503,
            code: 'rate_limit_unclassified',
            title: 'Request budget policy unavailable',
          },
          {
            status: 503,
            headers: {
              'content-type': 'application/problem+json',
              'cache-control': 'no-store',
              'retry-after': '5',
            },
          },
        );
      // Page navigation must first establish a miss. Batch enumeration,
      // availability and revision inventory retain their pre-read budgets.
      if (pageResolution(request)) return;
      return consume(request, server?.requestIP(request)?.address, family);
    })
    .mapResponse('global', async ({ request, server, responseValue, set }) => {
      if (!pageResolution(request)) return;
      const status = responseValue instanceof Response ? responseValue.status : set.status;
      if (status !== 400 && status !== 404 && status !== 422) return;
      return consume(request, server?.requestIP(request)?.address, 'address');
    })
    .error('global', async ({ request, server, error }) => {
      // Validation precedes beforeHandle. Cover standalone route plugins too;
      // the composition root's own 400 is charged by mapResponse above.
      if (
        !pageResolution(request) ||
        !(error instanceof ValidationError || error instanceof ParseError)
      )
        return;
      return (
        (await consume(request, server?.requestIP(request)?.address, 'address')) ??
        problem(400, 'invalid_request', 'Request does not match the Work contract')
      );
    });
}
