import { Elysia } from 'elysia';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import { rateLimitFamily, type Budgets, type PrincipalClass } from './budgets.ts';
import { anonymousIdentity, type RateLimitOptions, type RateLimitStore } from './store.ts';
import { PrincipalBudgetCache } from './principal-cache.ts';

export interface MainRateLimit {
  store: RateLimitStore;
  options: RateLimitOptions;
  budgets: Budgets;
}

export function rateLimitHook(account: Pick<AccountAssertionVerifier, 'verify'>, limit?: MainRateLimit) {
  const cache = new PrincipalBudgetCache();
  return new Elysia({ name: 'main-rate-limit-v1' }).beforeHandle('global', async function enforceRateLimit({ request, server }) {
    // Embedded route fixtures may omit deployment dependencies. The HTTP
    // composition root always supplies the store; no runtime fail-open switch.
    if (!limit) return;
    const anonymous = !request.headers.has('authorization');
    const family = rateLimitFamily(request.method, new URL(request.url).pathname);
    if (family === null) return;
    if (family === undefined) return Response.json({ type: 'about:blank', status: 503,
      code: 'rate_limit_unclassified', title: 'Request budget policy unavailable' }, { status: 503,
      headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', 'retry-after': '5' } });
    try {
      let principalClass: PrincipalClass = 'anonymous';
      let identity = anonymousIdentity(request, server?.requestIP(request)?.address, limit.options);
      // Intake capacity is independent of Account availability and bearer
      // validity. Public intake and signed provider handlers own their proof;
      // this boundary always attributes their capacity to the trusted peer IP.
      const independent = family === 'report' || family === 'correspondence' || family === 'provider';
      if (!anonymous && !independent) {
        if (family === 'search') {
          // Only a verified reader escapes anonymous search capacity. Reads
          // need no Access role lookup or counter store.
          await cache.verified(request.headers.get('authorization')!, () => account.verify(request, []));
          return;
        }
        const attribution = await cache.resolve(request.headers.get('authorization')!,
          () => account.verify(request, []), principal => limit.store.classify(principal));
        identity = attribution.identity;
        principalClass = attribution.principalClass;
      }
      const decision = await limit.store.consume(identity, family, limit.budgets[principalClass][family]);
      if (!decision.allowed) return Response.json({ type: 'about:blank', status: 429,
        code: 'rate_limited', title: 'Request budget exhausted', family }, { status: 429,
        headers: { 'content-type': 'application/problem+json', 'retry-after': String(decision.retryAfter), 'cache-control': 'no-store' } });
    } catch (error) {
      const status = error instanceof AccountAssertionDenied ? 401 : 503;
      return Response.json({ type: 'about:blank', status,
        code: status === 401 ? 'invalid_account_assertion' : 'rate_limit_unavailable',
        title: status === 401 ? 'Account assertion refused' : 'Request budget unavailable' }, { status,
        headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store',
          ...(status === 503 ? { 'retry-after': '5' } : {}) } });
    }
  });
}
