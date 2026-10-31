import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { readPageAuthors } from '../identity/read';
import { locales, localizeHref } from '../paraglide/runtime.js';
import { UUID } from './price';

type NativeOffer = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['offers']>['get']>>['data']>['offer'];
export type ContentEditionTerms = NonNullable<NativeOffer['contentEdition']>;
export type CapturedBenefit = { kind: 'mapped'; terms: ContentEditionTerms } | { kind: 'unknown' | 'unavailable' };

const id = v.pipe(v.string(), v.regex(UUID));
const boundedText = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
// Commerce's sanitized HTTP DTO, not the internal capture or Content's revision response.
const termsSchema = v.strictObject({
  benefit: v.strictObject({
    kind: v.literal('content-edition'),
    resourceType: v.literal('content.edition'),
    resource: v.strictObject({ route: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(65535)), id }),
    version: v.strictObject({ revisionId: id, sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)) }),
    action: v.literal('edition:read'),
  }),
  creatorAccountId: id,
  targetSubjectId: id,
  source: v.strictObject({ licence: boundedText }),
  saleTermsReference: boundedText,
  delivery: v.literal('fixed-content-edition'),
  acquisition: v.literal('one-time-account-bound'),
  quantity: v.literal(1),
});

/** Preserve historical absence and the exact supplied capture; never fill it from today's offer or subject. */
export function capturedBenefit(value: unknown, targetSubjectId: string): CapturedBenefit {
  if (value === null || value === undefined) return { kind: 'unknown' };
  if (!v.is(termsSchema, value) || value.targetSubjectId !== targetSubjectId) return { kind: 'unavailable' };
  return { kind: 'mapped', terms: value };
}

/** An active historical entitlement is usable here only for these exact accepted terms. */
export function sameCapturedBenefit(a: CapturedBenefit | undefined, b: CapturedBenefit): boolean {
  if (a?.kind !== 'mapped' || b.kind !== 'mapped') return false;
  const x = a.terms;
  const y = b.terms;
  return (
    x.creatorAccountId === y.creatorAccountId &&
    x.targetSubjectId === y.targetSubjectId &&
    x.source.licence === y.source.licence &&
    x.saleTermsReference === y.saleTermsReference &&
    x.benefit.resource.route === y.benefit.resource.route &&
    x.benefit.resource.id === y.benefit.resource.id &&
    x.benefit.version.revisionId === y.benefit.version.revisionId &&
    x.benefit.version.sha256 === y.benefit.version.sha256
  );
}

/** Navigation only. The served Content reader reauthorizes the current viewer and immutable source. */
export function benefitReaderHref(benefit: CapturedBenefit, active: boolean, locale: string): string | null {
  const language = locales.find((candidate) => candidate === locale);
  if (!active || benefit.kind !== 'mapped' || !language) return null;
  return localizeHref(`/editions/${encodeURIComponent(benefit.terms.benefit.resource.id)}`, { locale: language });
}

/** One optional public identity point for a detail's actual captured creator; never a subject's author. */
export async function benefitCreatorName(client: KernelClient, benefit: CapturedBenefit): Promise<string | undefined> {
  if (benefit.kind !== 'mapped') return undefined;
  const id = benefit.terms.creatorAccountId;
  const author = (await readPageAuthors(client, [id]))?.[id];
  if (!author || author.id !== id || author.state === 'deleted') return undefined;
  return author.displayName || (author.handle ? `@${author.handle}` : undefined);
}
