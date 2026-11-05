import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import { requireAccessDeadline } from '../request/unavailable.ts';

export type ContentEditionBenefit = Readonly<{
  kind: 'content-edition';
  resourceType: 'content.edition';
  resource: Readonly<{ route: number; id: string }>;
  version: Readonly<{ revisionId: string; sha256: string }>;
  action: 'edition:read';
}>;
declare const buyerFact: unique symbol;
export type ContentEditionBuyerFact = { readonly [buyerFact]: true };
export type ContentEditionBuyerFactInput = Readonly<{
  benefit: ContentEditionBenefit;
  buyerAccountId: string;
  entitlementId: string;
  entitlementRevision: number;
  time: AuthoritativeTime;
  deadline: number;
}>;
/** Internal native issuer; Commerce supplies validated current entitlement bindings. */
export function createContentEditionBuyerFact(input: ContentEditionBuyerFactInput): ContentEditionBuyerFact {
  const benefit = copyContentEditionBenefit(input.benefit);
  const buyerRoute = routeOf(input.buyerAccountId);
  if (
    buyerRoute === null ||
    routeOf(input.entitlementId) !== buyerRoute ||
    !Number.isSafeInteger(input.entitlementRevision) ||
    input.entitlementRevision <= 0
  )
    throw new TypeError('Invalid native entitlement binding');
  assertLifetime(input.time, input.deadline);
  const fact = Object.freeze({}) as ContentEditionBuyerFact;
  facts.set(
    fact,
    Object.freeze({
      benefit,
      buyerAccountId: input.buyerAccountId,
      entitlementId: input.entitlementId,
      entitlementRevision: input.entitlementRevision,
      time: input.time,
      deadline: input.deadline,
    }),
  );
  return fact;
}
export type ContentEditionBuyerFactReader = (
  input: Readonly<{
    benefit: ContentEditionBenefit;
    buyerAccountId: string;
    time: AuthoritativeTime;
    deadline: number;
  }>,
) => Promise<ContentEditionBuyerFact | null>;

// Only Commerce's trusted current native reader calls the issuer. The empty
// frozen handle reveals no entitlement data; copying it does not copy authority.
const facts = new WeakMap<ContentEditionBuyerFact, ContentEditionBuyerFactInput>();

function assertLifetime(time: AuthoritativeTime, deadline: number): void {
  if (!Number.isFinite(deadline) || deadline <= 0) throw new TypeError('Invalid buyer fact deadline');
  requireAccessDeadline(deadline);
  if (!Number.isFinite(Date.parse(authoritativeTimeValue(time)))) throw new TypeError('Invalid buyer fact time');
}

/** Copy only the exact native selector; this is never entitlement evidence. */
export function copyContentEditionBenefit(benefit: ContentEditionBenefit): ContentEditionBenefit {
  if (
    benefit?.kind !== 'content-edition' ||
    benefit.resourceType !== 'content.edition' ||
    benefit.action !== 'edition:read' ||
    !Number.isInteger(benefit.resource?.route) ||
    benefit.resource.route < 0 ||
    benefit.resource.route > 65535 ||
    routeOf(benefit.resource.id) !== benefit.resource.route ||
    routeOf(benefit.version?.revisionId) === null ||
    typeof benefit.version.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(benefit.version.sha256)
  )
    throw new TypeError('Invalid native content edition benefit');
  return Object.freeze({
    kind: 'content-edition',
    resourceType: 'content.edition',
    action: 'edition:read',
    resource: Object.freeze({ route: benefit.resource.route, id: benefit.resource.id }),
    version: Object.freeze({ revisionId: benefit.version.revisionId, sha256: benefit.version.sha256 }),
  });
}

export function contentEditionBenefitBinding(benefit: ContentEditionBenefit): string {
  const value = copyContentEditionBenefit(benefit);
  return JSON.stringify([
    value.kind,
    value.resourceType,
    value.resource.route,
    value.resource.id,
    value.version.revisionId,
    value.version.sha256,
    value.action,
  ]);
}

/** Final native identity check. Structural, cloned and expired facts never match. */
export function matchesContentEditionBuyerFact(
  fact: unknown,
  input: Parameters<ContentEditionBuyerFactReader>[0],
): fact is ContentEditionBuyerFact {
  if (typeof fact !== 'object' || fact === null) return false;
  const stored = facts.get(fact as ContentEditionBuyerFact);
  if (
    !stored ||
    stored.time !== input.time ||
    stored.deadline !== input.deadline ||
    stored.buyerAccountId !== input.buyerAccountId
  )
    return false;
  try {
    assertLifetime(stored.time, stored.deadline);
    return (
      routeOf(stored.buyerAccountId) !== null &&
      routeOf(stored.entitlementId) === routeOf(stored.buyerAccountId) &&
      Number.isSafeInteger(stored.entitlementRevision) &&
      stored.entitlementRevision > 0 &&
      contentEditionBenefitBinding(stored.benefit) === contentEditionBenefitBinding(input.benefit)
    );
  } catch {
    return false;
  }
}
