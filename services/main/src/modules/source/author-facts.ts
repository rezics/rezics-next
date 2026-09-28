import { t } from 'elysia';
import type { Static } from 'typebox';
import type { AuthorName } from './author-name.ts';

/** One retained capture (≤64 KiB) yields at most these fields, each bounded. */
export const AUTHOR_FACTS_COST = { captureBytes: 65_536, dateCharacters: 100, nameCharacters: 200,
  identifiers: 6, identifierCharacters: 32 } as const;

const identifierScheme = t.Union([t.Literal('project_gutenberg'), t.Literal('librivox'), t.Literal('wikidata'),
  t.Literal('lc_naf'), t.Literal('viaf'), t.Literal('isni')]);
type AuthorIdentifierScheme = Static<typeof identifierScheme>;
/**
 * Where an author page links onward, in its order: free books to read or hear
 * first, then the authority files that identify the person. Only these
 * identifiers are projected; the record's commercial and social catalogue IDs
 * (Amazon, Goodreads, IMDb…) stay in the capture. Addresses as each registry
 * publishes them (2026-09-28).
 */
const AUTHOR_IDENTIFIER_SCHEMES = {
  project_gutenberg: { pattern: /^[1-9][0-9]{0,6}$/, url: (id: string) => `https://www.gutenberg.org/ebooks/author/${id}` },
  librivox: { pattern: /^[1-9][0-9]{0,6}$/, url: (id: string) => `https://librivox.org/author/${id}` },
  wikidata: { pattern: /^Q[1-9][0-9]{0,11}$/, url: (id: string) => `https://www.wikidata.org/wiki/${id}` },
  lc_naf: { pattern: /^n[bors]?[0-9]{8,10}$/, url: (id: string) => `https://id.loc.gov/authorities/names/${id}.html` },
  viaf: { pattern: /^[1-9][0-9]{0,21}$/, url: (id: string) => `https://viaf.org/viaf/${id}` },
  isni: { pattern: /^[0-9]{15}[0-9X]$/, url: (id: string) => `https://isni.org/isni/${id}` },
} as const satisfies Record<AuthorIdentifierScheme, { pattern: RegExp; url: (id: string) => string }>;
const schemes = Object.keys(AUTHOR_IDENTIFIER_SCHEMES) as AuthorIdentifierScheme[];

/** Where a projected field came from: the retained capture, its revision and the head that selected it. */
export const sourceFactProvenance = { record: t.String(), observation: t.String(), revision: t.String(),
  sourceRevision: t.Nullable(t.String()), digest: t.String(), url: t.String(), fetchedAt: t.String(),
  basis: t.Literal('facts') };
const authorFactField = t.Union([t.Literal('/birth_date'), t.Literal('/death_date'),
  t.Literal('/fuller_name'), t.TemplateLiteral([t.Literal('/remote_ids/'), identifierScheme])]);
/** The name's provenance with the fact's own JSON Pointer into the same capture. */
const authorFactProvenance = t.Object({ ...sourceFactProvenance, field: authorFactField });
type AuthorFactProvenance = Static<typeof authorFactProvenance>;
const factDate = t.Object({ text: t.String({ minLength: 1, maxLength: AUTHOR_FACTS_COST.dateCharacters }),
  year: t.Nullable(t.Integer({ minimum: 1, maximum: 9999 })), month: t.Nullable(t.Integer({ minimum: 1, maximum: 12 })),
  day: t.Nullable(t.Integer({ minimum: 1, maximum: 31 })), approximate: t.Boolean(), source: authorFactProvenance });
export const authorFacts = t.Object({ birthDate: t.Nullable(factDate), deathDate: t.Nullable(factDate),
  fullerName: t.Nullable(t.Object({ value: t.String({ minLength: 1, maxLength: AUTHOR_FACTS_COST.nameCharacters }),
    source: authorFactProvenance })),
  identifiers: t.Array(t.Object({ scheme: identifierScheme,
    value: t.String({ minLength: 1, maxLength: AUTHOR_FACTS_COST.identifierCharacters }), url: t.String(),
    source: authorFactProvenance }), { maxItems: AUTHOR_FACTS_COST.identifiers }) });
export type AuthorFacts = Static<typeof authorFacts>;

/** A source date as written, and its parts when the text states them plainly. */
export interface SourceDate { text: string; year: number | null; month: number | null; day: number | null;
  approximate: boolean }
export interface AuthorFactsProjection { birthDate: SourceDate | null; deathDate: SourceDate | null;
  fullerName: string | null; identifiers: { scheme: AuthorIdentifierScheme; value: string; url: string }[] }

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december'];
const APPROXIMATE = /^(?:approximately|approx\.?|circa|ca\.?|c\.|about)\s*/iu;
const text = (value: unknown, limit: number): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);

function month(name: string): number | null {
  const lower = name.toLowerCase();
  if (lower.length < 3) return null;
  const index = MONTHS.findIndex(candidate => candidate === lower || (lower.length <= 4 && candidate.startsWith(lower)));
  return index < 0 ? null : index + 1;
}

/**
 * Open Library dates are free text: "December 16, 1775", "21 April 1816",
 * "1859-05-22", "ca. 1290", "approximately 1717". The text is kept as written;
 * the year, month and day are given only when it states them in one of those
 * forms and they name a real calendar day. Anything else keeps only its text.
 */
export function parseSourceDate(value: string): SourceDate {
  const unknown = { text: value, year: null, month: null, day: null, approximate: false };
  let rest = value.trim().replace(/\.$/u, '');
  const approximate = APPROXIMATE.exec(rest);
  if (approximate) rest = rest.slice(approximate[0].length);
  let parts: [string | undefined, string | undefined, string | undefined] | null = null;
  let match: RegExpExecArray | null;
  if ((match = /^(\d{1,4})-(\d{2})-(\d{2})$/u.exec(rest))) parts = [match[1], match[2], match[3]];
  else if ((match = /^(\p{L}+)\.? (\d{1,2}),? (\d{1,4})$/u.exec(rest))) parts = [match[3], match[1], match[2]];
  else if ((match = /^(\d{1,2}) (\p{L}+)\.?,? (\d{1,4})$/u.exec(rest))) parts = [match[3], match[2], match[1]];
  else if ((match = /^(\p{L}+)\.? (\d{1,4})$/u.exec(rest))) parts = [match[2], match[1], undefined];
  else if ((match = /^(\d{1,4})$/u.exec(rest))) parts = [match[1], undefined, undefined];
  if (!parts) return unknown;
  const year = Number(parts[0]);
  const monthNumber = parts[1] === undefined ? null : /^\d+$/u.test(parts[1]) ? Number(parts[1]) : month(parts[1]);
  const day = parts[2] === undefined ? null : Number(parts[2]);
  if (year < 1 || (parts[1] !== undefined && (monthNumber === null || monthNumber < 1 || monthNumber > 12))) return unknown;
  if (day !== null) {
    const date = new Date(Date.UTC(2000, monthNumber! - 1, day));
    date.setUTCFullYear(year);
    if (date.getUTCMonth() !== monthNumber! - 1 || date.getUTCDate() !== day) return unknown;
  }
  return { text: value, year, month: monthNumber, day, approximate: approximate !== null };
}

/**
 * The factual fields an author page shows besides the name, read field by
 * field from an Open Library author record whose identity the name projection
 * has already checked (`projectOpenLibraryAuthor`). A malformed field is left
 * out; it never hides the others. The bio is prose, photos are images, links
 * are someone's selection and alternate names are uncurated, so none of them
 * is projected. Provider shape: https://openlibrary.org/dev/docs/api/authors
 * (2026-09-28).
 */
export function projectOpenLibraryAuthorFacts(value: unknown): AuthorFactsProjection {
  const body = (value ?? {}) as { birth_date?: unknown; death_date?: unknown; fuller_name?: unknown;
    remote_ids?: unknown };
  const date = (field: unknown) => text(field, AUTHOR_FACTS_COST.dateCharacters) ? parseSourceDate(field) : null;
  const remote = body.remote_ids && typeof body.remote_ids === 'object' && !Array.isArray(body.remote_ids)
    ? body.remote_ids as Record<string, unknown> : {};
  return { birthDate: date(body.birth_date), deathDate: date(body.death_date),
    fullerName: text(body.fuller_name, AUTHOR_FACTS_COST.nameCharacters) ? body.fuller_name : null,
    identifiers: schemes.flatMap(scheme => {
      const id = remote[scheme];
      return typeof id === 'string' && AUTHOR_IDENTIFIER_SCHEMES[scheme].pattern.test(id)
        ? [{ scheme, value: id, url: AUTHOR_IDENTIFIER_SCHEMES[scheme].url(id) }] : [];
    }) };
}

/** The projection with each field's provenance: the name's, pointing at the field. */
export function authorFactsWithSource(projection: AuthorFactsProjection,
  nameSource: AuthorName['nameSource']): AuthorFacts {
  const source = (field: AuthorFactProvenance['field']) => ({ ...nameSource, field });
  return {
    birthDate: projection.birthDate && { ...projection.birthDate, source: source('/birth_date') },
    deathDate: projection.deathDate && { ...projection.deathDate, source: source('/death_date') },
    fullerName: projection.fullerName === null ? null
      : { value: projection.fullerName, source: source('/fuller_name') },
    identifiers: projection.identifiers.map(item => ({ ...item, source: source(`/remote_ids/${item.scheme}`) })),
  };
}
