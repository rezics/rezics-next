import { identityExpired, type IdentityExpiry } from './identity-expiry.ts';
import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { requireAccessDeadline } from './unavailable.ts';
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { Actor, AccountActor } from '../request/access.ts';
import type { WriteRateContext, AccountRateClass } from './write-rate.ts';

type Identity = IdentityExpiry & {
  pool: WriteRateContext['pool'];
  deadline: number;
  clock: KernelClock;
  route?: number;
  name: string;
  rateClass: AccountRateClass;
};
const identities = new WeakMap<Actor, Readonly<Identity>>();

/** Internal authentication handoff, only after all token/state/floor checks succeed. */
export function bindAccountRateIdentity(
  actor: AccountActor,
  context: WriteRateContext,
  facts: { route: number; createdAt: number | null; rateTier: string; operatorAccountId: string | null },
  expires: number,
  clock: KernelClock = systemClock,
  expiryClock: IdentityExpiry['expiryClock'] = 'kernel',
): void {
  const rateClass: AccountRateClass =
    facts.rateTier === 'service' && facts.operatorAccountId !== null
      ? 'service'
      : facts.rateTier === 'trusted'
        ? 'trusted'
        : typeof facts.createdAt === 'number' && clock().getTime() - facts.createdAt >= 7 * 86400000
          ? 'member'
          : 'new-account';
  identities.set(
    actor,
    Object.freeze({
      pool: context.pool,
      deadline: context.deadline,
      expires,
      expiryClock,
      clock,
      route: facts.route,
      name: `account:${actor.accountId}`,
      rateClass,
    }),
  );
}

// A restore's account facts are held privately until its final formula permits.
const pendingDurable = new WeakMap<AccountActor, Parameters<typeof bindAccountRateIdentity>>();
export function stageDurableRateIdentity(
  actor: AccountActor,
  context: WriteRateContext,
  facts: Parameters<typeof bindAccountRateIdentity>[2],
  time: AuthoritativeTime,
): void {
  const at = new Date(authoritativeTimeValue(time));
  pendingDurable.set(actor, [actor, context, facts, Infinity, () => at]);
}

export function finishDurableRateIdentity(actor: AccountActor, allowed: boolean): void {
  const pending = pendingDurable.get(actor);
  pendingDurable.delete(actor);
  if (allowed && pending) bindAccountRateIdentity(...pending);
}

/** Canonical socket/proxy attribution. IPv6 interface identifiers share a /64. */
export function canonicalRateAddress(address: string | undefined): string {
  if (!address || !isIP(address) || address.includes('%')) return 'unknown';
  if (isIP(address) === 4) return address;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split('::');
  const prefix = left ? left.split(':') : [];
  const suffix = right ? right.split(':') : [];
  const groups = canonical.includes('::')
    ? [...prefix, ...Array<string>(8 - prefix.length - suffix.length).fill('0'), ...suffix]
    : prefix;
  // IPv4-mapped socket addresses must not give an IPv4 client a second identity.
  if (
    groups.slice(0, 5).every((part) => Number.parseInt(part, 16) === 0) &&
    Number.parseInt(groups[5]!, 16) === 65535
  ) {
    const high = Number.parseInt(groups[6]!, 16);
    const low = Number.parseInt(groups[7]!, 16);
    return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  }
  return `${groups
    .slice(0, 4)
    .map((part) => Number.parseInt(part, 16).toString(16))
    .join(':')}::/64`;
}

export function bindAnonymousRateIdentity(
  context: WriteRateContext,
  request: Request,
  peer: string | undefined,
  options: { trustedProxyPeers: ReadonlySet<string>; clientIpHeader: string },
): void {
  if (context.actor.kind !== 'anonymous') throw new TypeError('Anonymous identity requires an anonymous actor');
  let address = peer;
  // Match the actual peer, not its /64; trust never extends to neighboring hosts.
  const canonicalPeer = (value: string) => (isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname : value);
  if (peer && isIP(peer) && options.trustedProxyPeers.has(canonicalPeer(peer))) {
    const forwarded = request.headers.get(options.clientIpHeader)?.trim();
    if (forwarded && isIP(forwarded)) address = forwarded;
  }
  identities.set(
    context.actor,
    Object.freeze({
      pool: context.pool,
      deadline: context.deadline,
      expires: Infinity,
      expiryClock: 'kernel',
      clock: systemClock,
      name: `anonymous:${canonicalRateAddress(address)}`,
      rateClass: 'anonymous',
    }),
  );
}

/** No serializable actor fields, client identifier or request JSON can mint this evidence. */
export function rateIdentity(context: WriteRateContext, secret: string) {
  requireAccessDeadline(context.deadline);
  const identity = identities.get(context.actor);
  if (identity) requireAccessDeadline(identity.deadline);
  if (!identity || identity.pool !== context.pool || identityExpired(identity, identity.clock))
    throw new Error('Verified rate identity unavailable');
  const identityDigest = createHmac('sha256', secret).update(identity.name).digest('hex');
  return {
    identityDigest,
    route: identity.route ?? Number.parseInt(identityDigest.slice(0, 4), 16),
    rateClass: identity.rateClass,
    deadline: Math.min(context.deadline, identity.deadline),
  };
}
