import { isIP } from 'node:net';
import type { WriteRateContext, WriteRateLimiter } from './write-rate.ts';
import { bindAnonymousRateIdentity } from './write-rate-identity.ts';
import { rateLimitUnits, type RateLimitDeclaration } from '../http/rate-limit.ts';
import { ProblemError } from '../http/problem.ts';
import { actionLabelOfMountedRoute, mountedRouteCatalogue, type MountedRoute } from '../http/request.ts';

export type WriteRateStageOptions = {
  trustedProxyPeers?: readonly string[];
  clientIpHeader?: string;
};

export function createWriteRateStage(limiter: WriteRateLimiter, options: WriteRateStageOptions = {}) {
  const trustedProxyPeers = new Set(
    (options.trustedProxyPeers ?? []).map((peer) => {
      if (!isIP(peer) || peer.includes('%')) throw new TypeError('Trusted proxy peers must be literal IP addresses');
      return peer.includes(':') ? new URL(`http://[${peer}]/`).hostname : peer;
    }),
  );
  const clientIpHeader = options.clientIpHeader ?? 'cf-connecting-ip';
  if (!/^[a-zA-Z0-9-]+$/.test(clientIpHeader)) throw new TypeError('Invalid client IP header');
  // This opaque charge receipt is bound to the actual request, never its body or receipt key.
  const charged = new WeakMap<Request, { declaration: string; context: WriteRateContext; spend: Promise<void> }>();
  return async (input: {
    request: Request;
    route?: string | undefined;
    routes?: readonly MountedRoute[];
    /** Already resolved by the shared native request stage. */
    mounted?: MountedRoute | undefined;
    body: unknown;
    context: WriteRateContext;
    peer?: string | undefined;
  }): Promise<void> => {
    const { request, context } = input;
    const unavailable = () =>
      new ProblemError('rate_limit_unavailable', { headers: { 'retry-after': '1', 'cache-control': 'no-store' } });
    const mounted =
      'mounted' in input
        ? input.mounted
        : input.routes && mountedRouteCatalogue(input.routes).find(request, input.route);
    const detail = mounted?.hooks?.detail as Record<string, unknown> | undefined;
    const declaration = detail?.['x-rate-limit'] as RateLimitDeclaration | undefined;
    if (declaration === undefined) {
      const action = detail?.['x-action'];
      // Explicit semantic read actions cover read-only POSTs. Method alone never exempts a POST.
      if (typeof action === 'string') {
        try {
          if (/:(read|list)$/.test(actionLabelOfMountedRoute(mounted))) return;
        } catch {
          throw unavailable();
        }
      }
      if (action === undefined && ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
      throw unavailable();
    }
    let units: number;
    try {
      units = rateLimitUnits(declaration, input.body);
    } catch {
      throw unavailable();
    }
    const key = `${mounted?.method} ${mounted?.path} ${declaration.family}:${units}`;
    const previous = charged.get(request);
    if (previous) {
      if (
        previous.declaration !== key ||
        previous.context.actor !== context.actor ||
        previous.context.pool !== context.pool ||
        previous.context.deadline !== context.deadline ||
        Date.now() >= context.deadline
      )
        throw unavailable();
      return previous.spend;
    }
    const spend = Promise.resolve().then(async () => {
      if (context.actor.kind === 'anonymous')
        bindAnonymousRateIdentity(context, request, input.peer, { trustedProxyPeers, clientIpHeader });
      let decision;
      try {
        decision = await limiter.spend(context, declaration.family, units);
      } catch {
        throw unavailable();
      }
      if (!decision.allowed) {
        if (!Number.isSafeInteger(decision.retryAfter) || decision.retryAfter < 1) throw unavailable();
        throw new ProblemError('rate_limited', {
          headers: { 'retry-after': String(decision.retryAfter), 'cache-control': 'no-store' },
        });
      }
    });
    charged.set(request, { declaration: key, context, spend });
    return spend;
  };
}
