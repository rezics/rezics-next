import { t } from 'elysia';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { canonicalLanguage } from '../display-language/select.ts';
import { isbnOk, releaseIdentifier } from '../release/schema.ts';

const closed = { additionalProperties: false } as const;
const text = t.String({ minLength: 1, maxLength: 500, pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
const language = t.String({ minLength: 2, maxLength: 35 });
export const candidateText = t.Object({ value: text, language }, closed);
export const candidateInput = t.Object({
  profile: t.Literal('catalogue-candidates-v1'),
  originalTitle: candidateText,
  aliases: t.Array(candidateText, { maxItems: 8 }),
  romanizations: t.Array(candidateText, { maxItems: 8 }),
  creators: t.Array(text, { maxItems: 4 }),
  dates: t.Array(t.Integer({ minimum: 1, maximum: 9999 }), { maxItems: 4 }),
  identifiers: t.Array(t.Union([
    t.Object({ isbn13: t.String({ pattern: '^97[89][0-9]{10}$' }) }, closed),
    t.Object({ provider: releaseIdentifier.properties.provider, identifier: releaseIdentifier.properties.value }, closed),
  ]), { maxItems: 4 }),
}, closed);
export type CandidateInput = Static<typeof candidateInput>;
export const declaredGrain = t.Union([t.Literal('new-creative-scope'), t.Literal('translation'), t.Literal('version'), t.Literal('translation-or-version'),
  t.Literal('publication'), t.Literal('collection')]);
export type DeclaredGrain = Static<typeof declaredGrain>;
export class CatalogueInvalid extends Error {}
export class CatalogueUnavailable extends Error {}
export class CataloguePendingLimit extends Error {}
export class CatalogueStale extends Error {}

/** At most 21 lexical index queries, 4 identifier pages and 128 unique Works.
 * Live supplementary matching is O(visible Works x current metadata), capped at
 * 129 rows / 1 MiB and fails explicitly on overflow; no truncated success receipt. */
export const CATALOGUE_COST = { candidates: 128, graphBytes: 1024 * 1024,
  graphCalls: 160, totalGraphBytes: 4 * 1024 * 1024, deadlineMs: 10_000,
  receiptLifetimeMs: 30 * 60 * 1000, pending: 3 } as const;

export function checkedCandidates(input: unknown): CandidateInput {
  if (!Value.Check(candidateInput, input)) throw new CatalogueInvalid('Candidate search input is invalid');
  const checked = structuredClone(input);
  for (const title of [checked.originalTitle, ...checked.aliases, ...checked.romanizations]) {
    const tag = canonicalLanguage(title.language);
    if (!tag) throw new CatalogueInvalid('Title language is invalid');
    title.language = tag;
    title.value = title.value.normalize('NFC').trim();
    if (title.value.length < 1) throw new CatalogueInvalid('A searchable title is required');
  }
  checked.creators = checked.creators.map(value => value.normalize('NFC').trim());
  if (checked.creators.some(value => !value)) throw new CatalogueInvalid('A searchable creator name is required');
  if (checked.identifiers.some(value => 'isbn13' in value && !isbnOk(value.isbn13))) {
    throw new CatalogueInvalid('ISBN-13 checksum is invalid');
  }
  return checked;
}

export function grainOwner(grain: DeclaredGrain) {
  switch (grain) {
    case 'new-creative-scope': return null;
    case 'translation':
    case 'version':
    case 'translation-or-version': return { method: 'PUT', path: '/v1/works/{work}/realizations/{realization}' };
    case 'publication': return { method: 'PUT', path: '/v1/works/{work}/releases/{release}' };
    case 'collection': return { method: 'POST', path: '/v1/collections' };
  }
}
