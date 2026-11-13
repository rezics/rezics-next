import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import { requireAccessDeadline } from './unavailable.ts';

/** A Post benefit names the stable Post/action; Content still selects each revision. */
export type ContentPostBenefit = Readonly<{
  kind: 'content-post';
  resourceType: 'content.post';
  resource: Readonly<{ route: number; id: string }>;
  action: 'post:read';
}>;

/** A fixed-edition benefit retains the exact immutable revision and digest. */
export type ContentEditionBenefit = Readonly<{
  kind: 'content-edition';
  resourceType: 'content.edition';
  resource: Readonly<{ route: number; id: string }>;
  version: Readonly<{ revisionId: string; sha256: string }>;
  action: 'edition:read';
}>;

/** Closed Commerce-to-Access target contract; adding a target requires an explicit owner arm. */
export type AuthenticatedContentBenefit = ContentPostBenefit | ContentEditionBenefit;

declare const editionBuyerFact: unique symbol;
declare const postBuyerFact: unique symbol;
export type ContentEditionBuyerFact = { readonly [editionBuyerFact]: true };
export type ContentPostBuyerFact = { readonly [postBuyerFact]: true };
export type ContentBuyerFact = ContentEditionBuyerFact | ContentPostBuyerFact;

export type ContentEditionBuyerFactInput = Readonly<{
  benefit: ContentEditionBenefit;
  buyerAccountId: string;
  entitlementId: string;
  entitlementRevision: number;
  time: AuthoritativeTime;
  deadline: number;
}>;
export type ContentPostBuyerFactInput = Readonly<{
  benefit: ContentPostBenefit;
  buyerAccountId: string;
  entitlementId: string;
  entitlementRevision: number;
  time: AuthoritativeTime;
  deadline: number;
}>;

export type ContentEditionBuyerFactReader = (
  input: Readonly<{
    benefit: ContentEditionBenefit;
    buyerAccountId: string;
    time: AuthoritativeTime;
    deadline: number;
  }>,
) => Promise<ContentEditionBuyerFact | null>;
export type ContentPostBuyerFactReader = (
  input: Readonly<{
    benefit: ContentPostBenefit;
    buyerAccountId: string;
    time: AuthoritativeTime;
    deadline: number;
  }>,
) => Promise<ContentPostBuyerFact | null>;

type FactData = Readonly<{
  benefit: AuthenticatedContentBenefit;
  buyerAccountId: string;
  entitlementId: string;
  entitlementRevision: number;
  time: AuthoritativeTime;
  deadline: number;
}>;

const facts = new WeakMap<object, FactData>();

/** Internal native issuer; Commerce supplies a validated current exact entitlement binding. */
export function createContentEditionBuyerFact(input: ContentEditionBuyerFactInput): ContentEditionBuyerFact {
  const benefit = copyContentEditionBenefit(input.benefit);
  validateFactBinding(input, benefit.resource.route);
  const fact = Object.freeze({}) as ContentEditionBuyerFact;
  facts.set(fact, Object.freeze({ ...input, benefit }));
  return fact;
}

/** Internal native issuer; Commerce supplies the stable Post key, without a revision selector. */
export function createContentPostBuyerFact(input: ContentPostBuyerFactInput): ContentPostBuyerFact {
  const benefit = copyContentPostBenefit(input.benefit);
  validateFactBinding(input, benefit.resource.route);
  const fact = Object.freeze({}) as ContentPostBuyerFact;
  facts.set(fact, Object.freeze({ ...input, benefit }));
  return fact;
}

function validateFactBinding(
  input: Readonly<{
    buyerAccountId: string;
    entitlementId: string;
    entitlementRevision: number;
    time: AuthoritativeTime;
    deadline: number;
  }>,
  resourceRoute: number,
): void {
  const buyerRoute = routeOf(input.buyerAccountId);
  if (
    buyerRoute === null ||
    routeOf(input.entitlementId) !== buyerRoute ||
    !Number.isSafeInteger(input.entitlementRevision) ||
    input.entitlementRevision <= 0 ||
    resourceRoute < 0 ||
    resourceRoute > 65535
  )
    throw new TypeError('Invalid native entitlement binding');
  assertLifetime(input.time, input.deadline);
}

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

export function copyContentPostBenefit(benefit: ContentPostBenefit): ContentPostBenefit {
  if (
    benefit?.kind !== 'content-post' ||
    benefit.resourceType !== 'content.post' ||
    benefit.action !== 'post:read' ||
    !Number.isInteger(benefit.resource?.route) ||
    benefit.resource.route < 0 ||
    benefit.resource.route > 65535 ||
    routeOf(benefit.resource.id) !== benefit.resource.route
  )
    throw new TypeError('Invalid native content Post benefit');
  return Object.freeze({
    kind: 'content-post',
    resourceType: 'content.post',
    action: 'post:read',
    resource: Object.freeze({ route: benefit.resource.route, id: benefit.resource.id }),
  });
}

/** Content derives this exact routed key from its already selected native Post row. */
export function contentPostBenefitForPost(postId: string): ContentPostBenefit {
  const route = routeOf(postId);
  if (route === null) throw new TypeError('Invalid native content Post identity');
  return copyContentPostBenefit({
    kind: 'content-post',
    resourceType: 'content.post',
    resource: { route, id: postId },
    action: 'post:read',
  });
}

/** Exhaustive copy of the deliberately small native target union. */
export function copyAuthenticatedContentBenefit(benefit: AuthenticatedContentBenefit): AuthenticatedContentBenefit {
  switch (benefit?.kind) {
    case 'content-post':
      return copyContentPostBenefit(benefit);
    case 'content-edition':
      return copyContentEditionBenefit(benefit);
    default:
      throw new TypeError('Invalid authenticated Content benefit');
  }
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

export function contentPostBenefitBinding(benefit: ContentPostBenefit): string {
  const value = copyContentPostBenefit(benefit);
  return JSON.stringify([value.kind, value.resourceType, value.resource.route, value.resource.id, value.action]);
}

export function authenticatedContentBenefitBinding(benefit: AuthenticatedContentBenefit): string {
  return benefit.kind === 'content-post' ? contentPostBenefitBinding(benefit) : contentEditionBenefitBinding(benefit);
}

function matchesFact(
  fact: unknown,
  input: Readonly<{
    benefit: AuthenticatedContentBenefit;
    buyerAccountId: string;
    time: AuthoritativeTime;
    deadline: number;
  }>,
): fact is ContentBuyerFact {
  if (typeof fact !== 'object' || fact === null) return false;
  const stored = facts.get(fact);
  if (
    !stored ||
    stored.time !== input.time ||
    stored.deadline !== input.deadline ||
    stored.buyerAccountId !== input.buyerAccountId ||
    stored.benefit.kind !== input.benefit.kind
  )
    return false;
  try {
    assertLifetime(stored.time, stored.deadline);
    return (
      routeOf(stored.buyerAccountId) !== null &&
      routeOf(stored.entitlementId) === routeOf(stored.buyerAccountId) &&
      Number.isSafeInteger(stored.entitlementRevision) &&
      stored.entitlementRevision > 0 &&
      authenticatedContentBenefitBinding(stored.benefit) === authenticatedContentBenefitBinding(input.benefit)
    );
  } catch {
    return false;
  }
}

/** Final exact-edition identity check. Structural, cloned and expired facts never match. */
export function matchesContentEditionBuyerFact(
  fact: unknown,
  input: Parameters<ContentEditionBuyerFactReader>[0],
): fact is ContentEditionBuyerFact {
  return input.benefit.kind === 'content-edition' && matchesFact(fact, input);
}

/** Final stable-Post identity check. A revision change cannot widen this selector to another Post. */
export function matchesContentPostBuyerFact(
  fact: unknown,
  input: Parameters<ContentPostBuyerFactReader>[0],
): fact is ContentPostBuyerFact {
  return input.benefit.kind === 'content-post' && matchesFact(fact, input);
}
