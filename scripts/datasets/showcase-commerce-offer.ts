import type { DevelopmentSeedFailure, DevelopmentShowcaseClient } from './showcase-community.ts';
import type { DevelopmentContentEditionOutcome } from './showcase-content-edition.ts';
import { routeOf } from '../../services/kernel/src/route/route.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OFFER_PAGE_LIMIT = 100;
const OFFER_PAGE_CAP = 100;
const TAX_CODE = 'txcd_10302000';
const OFFER_TITLE = 'Local showcase authored edition';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type MoneyUnit = Readonly<{ system: 'stripe-api'; exponent: 0 | 2; factsVersion: 'stripe-money-v1' }>;
type CurrencyRule = Readonly<{ currency: 'usd' | 'eur'; amount: number; unit: MoneyUnit }>;

function currencyRules(value: unknown): CurrencyRule[] {
  const body = record(value);
  if (
    !body ||
    body.factsVersion !== 'stripe-money-v1' ||
    body.taxBehavior !== 'exclusive' ||
    !Array.isArray(body.configuredSaleCurrencies) ||
    body.configuredSaleCurrencies.length < 1 ||
    body.configuredSaleCurrencies.length > 2
  )
    throw new TypeError('Commerce money schema is invalid');
  const seen = new Set<string>();
  return body.configuredSaleCurrencies.map((value) => {
    const rule = record(value);
    const unit = record(rule?.unit);
    if (
      !rule ||
      (rule.currency !== 'usd' && rule.currency !== 'eur') ||
      seen.has(rule.currency) ||
      !unit ||
      unit.system !== 'stripe-api' ||
      (unit.exponent !== 0 && unit.exponent !== 2) ||
      unit.factsVersion !== 'stripe-money-v1' ||
      rule.minAmountMinor !== 50 ||
      rule.maxAmountMinor !== 99_999_999 ||
      rule.chargeMultiple !== 1
    )
      throw new TypeError('Commerce sale currency rule is invalid');
    seen.add(rule.currency);
    return {
      currency: rule.currency,
      amount: rule.minAmountMinor,
      unit: {
        system: 'stripe-api',
        exponent: unit.exponent,
        factsVersion: 'stripe-money-v1',
      },
    };
  });
}

type EditionBinding = Readonly<{
  editionId: string;
  editionRevision: string;
  accountId: string;
  targetSubjectId: string;
  revisionId: string;
  sha256: string;
  licence: string;
  saleTermsReference: string;
}>;

function exactEditionBinding(value: unknown, expected: EditionBinding): string | undefined {
  const contentEdition = record(value);
  const benefit = record(contentEdition?.benefit);
  const resource = record(benefit?.resource);
  const version = record(benefit?.version);
  const source = record(contentEdition?.source);
  if (
    benefit?.kind !== 'content-edition' ||
    benefit.resourceType !== 'content.edition' ||
    resource?.route !== routeOf(expected.editionId) ||
    resource?.id !== expected.editionId ||
    benefit.action !== 'edition:read' ||
    version?.revisionId !== expected.revisionId ||
    version.sha256 !== expected.sha256 ||
    contentEdition?.creatorAccountId !== expected.accountId ||
    contentEdition.targetSubjectId !== expected.targetSubjectId ||
    source?.licence !== expected.licence ||
    contentEdition.saleTermsReference !== expected.saleTermsReference ||
    contentEdition.delivery !== 'fixed-content-edition' ||
    contentEdition.acquisition !== 'one-time-account-bound' ||
    contentEdition.quantity !== 1
  )
    return undefined;
  return contentEdition.saleTermsReference;
}

function createdOffer(
  value: unknown,
  expected: EditionBinding,
  frozenBody: unknown,
  rules: readonly CurrencyRule[],
): {
  offerId: string;
  saleTermsReference: string;
  currency: 'usd' | 'eur';
  unitAmountMinor: number;
  taxBehavior: 'exclusive';
  moneyUnit: MoneyUnit;
} {
  const offer = record(record(value)?.offer);
  const body = record(frozenBody);
  const moneyUnit = record(offer?.moneyUnit);
  const saleTermsReference = exactEditionBinding(offer?.contentEdition, expected);
  if (
    !body ||
    body.contentEditionId !== expected.editionId ||
    body.title !== OFFER_TITLE ||
    (body.currency !== 'usd' && body.currency !== 'eur') ||
    typeof body.unitAmountMinor !== 'number' ||
    !Number.isSafeInteger(body.unitAmountMinor) ||
    body.unitAmountMinor < 50 ||
    body.unitAmountMinor > 99_999_999 ||
    body.taxCode !== TAX_CODE ||
    !offer ||
    typeof offer.id !== 'string' ||
    !UUID.test(offer.id) ||
    offer.targetSubjectId !== expected.targetSubjectId ||
    offer.title !== body.title ||
    offer.state !== 'active' ||
    (offer.currency !== 'usd' && offer.currency !== 'eur') ||
    offer.currency !== body.currency ||
    typeof offer.unitAmountMinor !== 'number' ||
    !Number.isSafeInteger(offer.unitAmountMinor) ||
    offer.unitAmountMinor !== body.unitAmountMinor ||
    offer.taxBehavior !== 'exclusive' ||
    !moneyUnit ||
    moneyUnit.system !== 'stripe-api' ||
    (moneyUnit.exponent !== 0 && moneyUnit.exponent !== 2) ||
    moneyUnit.factsVersion !== 'stripe-money-v1' ||
    (rules.find((rule) => rule.currency === body.currency) !== undefined &&
      moneyUnit.exponent !== rules.find((rule) => rule.currency === body.currency)!.unit.exponent) ||
    saleTermsReference === undefined
  )
    throw new TypeError('Native offer response did not acknowledge the eligible edition binding');
  return {
    offerId: offer.id,
    saleTermsReference,
    currency: offer.currency,
    unitAmountMinor: offer.unitAmountMinor,
    taxBehavior: 'exclusive',
    moneyUnit: {
      system: 'stripe-api',
      exponent: moneyUnit.exponent,
      factsVersion: 'stripe-money-v1',
    },
  };
}

function creatorOfferMatches(value: unknown, expected: EditionBinding & {
  offerId: string;
  currency: 'usd' | 'eur';
  unitAmountMinor: number;
  taxBehavior: 'exclusive';
  taxCode: string;
  moneyUnit: MoneyUnit;
}): { royaltyBasisPoints: number } | undefined {
  const offer = record(value);
  const unit = record(offer?.moneyUnit);
  if (
    offer?.id === expected.offerId &&
    offer.targetSubjectId === expected.targetSubjectId &&
    offer.title === OFFER_TITLE &&
    offer.state === 'active' &&
    offer.currency === expected.currency &&
    offer.unitAmountMinor === expected.unitAmountMinor &&
    offer.taxBehavior === expected.taxBehavior &&
    offer.taxCode === expected.taxCode &&
    typeof offer.royaltyBasisPoints === 'number' &&
    Number.isInteger(offer.royaltyBasisPoints) &&
    offer.royaltyBasisPoints >= 0 &&
    offer.royaltyBasisPoints <= 10_000 &&
    unit?.system === expected.moneyUnit.system &&
    unit.exponent === expected.moneyUnit.exponent &&
    unit.factsVersion === expected.moneyUnit.factsVersion &&
    exactEditionBinding(offer.contentEdition, expected) === expected.saleTermsReference
  ) {
    const royaltyBasisPoints = offer.royaltyBasisPoints;
    if (typeof royaltyBasisPoints === 'number') return { royaltyBasisPoints };
  }
  return undefined;
}

export type DevelopmentOfferOutcome = Readonly<
  | DevelopmentSeedFailure
  | {
      state: 'created';
      offerId: string;
      contentEditionId: string;
      editionRevision: string;
      targetSubjectId: string;
      source: { revisionId: string; sha256: string; licence: string };
      currency: 'usd' | 'eur';
      unitAmountMinor: number;
      taxBehavior: 'exclusive';
      taxCode: string;
      royaltyBasisPoints: number;
      moneyUnit: MoneyUnit;
    }
>;

/** Create the local ordinary Commerce offer only after the native edition exists and is published. */
export async function seedDevelopmentContentEditionOffer(input: {
  edition: DevelopmentContentEditionOutcome;
  accountId: string;
  client: DevelopmentShowcaseClient;
}): Promise<DevelopmentOfferOutcome> {
  if (input.edition.state !== 'published') return input.edition;
  const money = await input.client.read('/v1/commerceMoney', { anonymous: true });
  if (money.state !== 'acknowledged') return { ...money, operation: 'commerce.money_schema' };
  let rules: CurrencyRule[];
  try {
    rules = currencyRules(money.value);
  } catch {
    return { state: 'unavailable', operation: 'commerce.money_schema', code: 'response-unavailable' };
  }
  const currency = rules.find((rule) => rule.currency === 'usd') ?? rules[0];
  if (!currency) return { state: 'unavailable', operation: 'commerce.money_schema', code: 'sale-currency-unconfigured' };

  const binding: EditionBinding = {
    editionId: input.edition.editionId,
    editionRevision: input.edition.editionRevision,
    accountId: input.accountId,
    targetSubjectId: input.edition.source.targetSubjectId,
    revisionId: input.edition.source.revisionId,
    sha256: input.edition.source.sha256,
    licence: input.edition.source.licence,
    saleTermsReference: JSON.stringify([
      input.edition.editionId,
      input.edition.source.revisionId,
      input.edition.source.sha256,
      input.edition.editionRevision,
    ]),
  };
  const created = await input.client.command(
    {
      actionKey: `local-showcase-offer:${binding.editionId}`,
      idempotencyKey: `local-showcase-offer:${binding.editionId}`,
      method: 'POST',
      path: '/v1/offers',
      body: {
        contentEditionId: binding.editionId,
        title: OFFER_TITLE,
        currency: currency.currency,
        unitAmountMinor: currency.amount,
        taxCode: TAX_CODE,
      },
    },
    (value, frozenBody) => createdOffer(value, binding, frozenBody, rules),
  );
  if (created.state !== 'acknowledged') return { ...created, operation: 'offer.create' };

  const expected = {
    ...binding,
    offerId: created.value.offerId,
    editionRevision: binding.editionRevision,
    saleTermsReference: created.value.saleTermsReference,
    currency: created.value.currency,
    unitAmountMinor: created.value.unitAmountMinor,
    taxBehavior: created.value.taxBehavior,
    taxCode: TAX_CODE,
    moneyUnit: created.value.moneyUnit,
  };
  let cursor: string | undefined;
  const seen = new Set<string>();
  let reachedEnd = false;
  for (let pageNumber = 0; pageNumber < OFFER_PAGE_CAP; pageNumber++) {
    const query = new URLSearchParams({ limit: String(OFFER_PAGE_LIMIT) });
    if (cursor) query.set('cursor', cursor);
    const creatorRead = await input.client.read(`/v1/offers?${query}`);
    if (creatorRead.state !== 'acknowledged') return { ...creatorRead, operation: 'creator.offers' };
    const page = record(creatorRead.value);
    if (!page || !Array.isArray(page.offers) || !(typeof page.next === 'string' || page.next === null))
      return { state: 'unavailable', operation: 'creator.offers', code: 'response-unavailable' };
    let readback: { royaltyBasisPoints: number } | undefined;
    for (const offer of page.offers) {
      readback = creatorOfferMatches(offer, expected);
      if (readback) break;
    }
    if (readback) {
      return {
        state: 'created',
        offerId: expected.offerId,
        contentEditionId: binding.editionId,
        editionRevision: binding.editionRevision,
        targetSubjectId: binding.targetSubjectId,
        source: { revisionId: binding.revisionId, sha256: binding.sha256, licence: binding.licence },
        currency: expected.currency,
        unitAmountMinor: expected.unitAmountMinor,
        taxBehavior: expected.taxBehavior,
        taxCode: expected.taxCode,
        royaltyBasisPoints: readback.royaltyBasisPoints,
        moneyUnit: expected.moneyUnit,
      };
    }
    if (page.next === null) {
      reachedEnd = true;
      break;
    }
    if (page.next.length > 4096 || seen.has(page.next))
      return { state: 'unavailable', operation: 'creator.offers', code: 'cursor-unavailable' };
    seen.add(page.next);
    cursor = page.next;
  }
  return reachedEnd
    ? { state: 'refused', operation: 'creator.offers', code: 'created-offer-not-in-creator-read' }
    : { state: 'unavailable', operation: 'creator.offers', code: 'creator-page-cap' };
}
