import { pickLanguage } from '@rezics/composition';
import { originalLanguage } from '../../subject/language.ts';
import type { Related, Subject } from '../../subject/types.ts';

type JsonValue = string | number | JsonValue[] | { [key: string]: JsonValue };
// The kernel client infers statement values as one union. Indexing it is too large for the compiler,
// and every field below is checked again at run time.
type Statement = {
  rank: string;
  value: { type: string; content?: unknown };
  property: { data_type: string };
  qualifiers?: { property: { id: string }; value: { type: string; content?: unknown } }[];
};

const idBase = 'https://rezics.com/id/';
const prefixes = new Map([
  ['wd', 'http://www.wikidata.org/entity/'],
  ['wdt', 'http://www.wikidata.org/prop/direct/'],
  ['bf', 'http://id.loc.gov/ontologies/bibframe/'],
]);
const reserved = new Set([
  '@context',
  '@id',
  '@type',
  'additionalType',
  'url',
  'name',
  'description',
  'alternateName',
  'identifier',
]);

function text<T extends string | string[]>(
  values: Record<string, T>,
  locale: string,
  original?: string,
): T | undefined {
  const language = pickLanguage(
    Object.keys(values).filter((key) => values[key]?.length),
    locale,
    original,
  );
  return language === undefined ? undefined : values[language];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function date(value: unknown): string | undefined {
  // Accept both a time payload and an explicitly wrapped time value.
  if (record(value) && value.type === 'value') value = value.content;
  if (!record(value) || typeof value.time !== 'string' || typeof value.precision !== 'number') return;
  if (!Number.isInteger(value.precision) || value.precision < 9) return;
  const parts = /^\+?(\d+)-(\d{2})-(\d{2})T/.exec(value.time);
  if (!parts || !/[1-9]/.test(parts[1]!)) return;
  const year = parts[1]!.replace(/^0+/, '').padStart(4, '0');
  if (value.precision === 9) return year;
  const month = Number(parts[2]);
  if (month < 1 || month > 12) return;
  if (value.precision === 10) return `${year}-${parts[2]}`;
  const day = Number(parts[3]);
  if (day < 1 || day > 31) return;
  return `${year}-${parts[2]}-${parts[3]}`;
}

function statementValue(statement: Statement, references: Map<string, JsonValue>): JsonValue | undefined {
  if (statement.value.type !== 'value') return;
  const content = statement.value.content;
  switch (statement.property.data_type) {
    case 'wikibase-item':
      return typeof content === 'string' ? references.get(content) : undefined;
    case 'string':
    case 'external-id':
    case 'url':
      return typeof content === 'string' ? content : undefined;
    case 'monolingualtext':
      if (record(content) && typeof content.text === 'string' && typeof content.language === 'string')
        return { '@value': content.text, '@language': content.language };
      return;
    case 'quantity': {
      if (!record(content) || typeof content.amount !== 'string' || typeof content.unit !== 'string') return;
      const amount = Number(content.amount);
      if (!content.amount.trim() || !Number.isFinite(amount)) return;
      return content.unit === '1' ? amount : { '@type': 'QuantitativeValue', value: amount, unitText: content.unit };
    }
    case 'time':
      return date(content);
    case 'document':
    case 'media':
      return;
  }
}

/** Map only the public subject representation and the related labels it discloses. */
export function subjectJsonLd({
  subject,
  related,
  locale,
  url,
  origin,
  typeLabel,
  subjectLabel,
  schemaOrgType,
  ratings,
}: {
  subject: Subject;
  related: Related;
  locale: string;
  url: string;
  origin?: string;
  typeLabel?: string;
  subjectLabel?: string;
  schemaOrgType?: string;
  ratings?: { figures: { population: string; count: number; mean?: number; remaining?: number }[] };
}): Record<string, JsonValue> {
  const original = originalLanguage(subject);
  const site = (origin ?? new URL(url).origin).replace(/\/+$/, '');
  const label = subjectLabel ?? text(subject.labels, locale, original) ?? '';
  const schemaType = /^https:\/\/schema\.org\/([A-Za-z0-9_-]+)$/.exec(schemaOrgType ?? '')?.[1];
  const entries: [string, JsonValue][] = [
    ['@context', 'https://schema.org'],
    ['@id', `${idBase}${subject.id}`],
    ['@type', schemaType ?? (subject.type.startsWith('schema:') ? subject.type.slice(7) : 'Thing')],
    ['url', url],
  ];
  if (!subject.type.startsWith('schema:')) {
    const separator = subject.type.indexOf(':');
    const base = separator > 0 ? prefixes.get(subject.type.slice(0, separator)) : undefined;
    if (base) entries.push(['additionalType', base + subject.type.slice(separator + 1)]);
  }
  const name = text(subject.labels, locale, original);
  const description = text(subject.descriptions, locale, original);
  const aliases = text(subject.aliases, locale, original);
  if (name !== undefined) entries.push(['name', name]);
  if (description !== undefined) entries.push(['description', description]);
  if (aliases !== undefined) entries.push(['alternateName', [...aliases]]);

  // Select each related label once, even when many statements reference the same subject.
  const references = new Map<string, JsonValue>();
  for (const [id, entry] of Object.entries(related)) {
    const label = text(entry.labels, locale);
    references.set(id, { '@id': `${idBase}${entry.redirect ?? id}`, ...(label === undefined ? {} : { name: label }) });
  }

  const identifiers: JsonValue[] = [];
  for (const [property, statements] of Object.entries(subject.statements)) {
    const key = property.startsWith('schema:') ? property.slice(7) : undefined;
    const externalId = /^wdt:P\d+$/.test(property);
    if ((key === undefined && !externalId) || (key !== undefined && reserved.has(key))) continue;
    const publicStatements = statements.filter((statement) => {
      if (statement.rank !== 'normal' && statement.rank !== 'preferred') return false;
      return !(statement.qualifiers ?? []).some((qualifier) => {
        if (qualifier.property.id !== 'rezics:spoilerLevel' || qualifier.value.type !== 'value') return false;
        const content = qualifier.value.content;
        const level = record(content) && typeof content.amount === 'string' ? Number(content.amount) : 2;
        return !Number.isInteger(level) || level > 0;
      });
    });
    const rank = publicStatements.some((statement) => statement.rank === 'preferred') ? 'preferred' : 'normal';
    const values: JsonValue[] = [];
    for (const statement of publicStatements) {
      if (statement.rank !== rank) continue;
      if (externalId && statement.property.data_type !== 'external-id') continue;
      const value = statementValue(statement, references);
      if (value === undefined) continue;
      if (externalId) {
        identifiers.push({
          '@type': 'PropertyValue',
          propertyID: `http://www.wikidata.org/entity/${property.slice(4)}`,
          value,
        });
      } else {
        values.push(value);
      }
    }
    if (key !== undefined && values.length) entries.push([key, values.length === 1 ? values[0]! : values]);
  }
  if (identifiers.length) entries.push(['identifier', identifiers]);
  const global = ratings?.figures.find((figure) => figure.population === '00000000-0000-8000-8000-000000000000');
  if (global && global.count > 0 && global.mean !== undefined && global.remaining === undefined) {
    entries.push([
      'aggregateRating',
      {
        '@type': 'AggregateRating',
        ratingValue: global.mean,
        bestRating: 20,
        worstRating: 0,
        ratingCount: global.count,
      },
    ]);
  }
  entries.push([
    '@graph',
    [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          {
            '@type': 'ListItem',
            position: 1,
            name: 'REZICS',
            item: `${site}/${encodeURIComponent(locale)}`,
          },
          {
            '@type': 'ListItem',
            position: 2,
            name: typeLabel ?? subject.type,
            item: `${site}/${encodeURIComponent(locale)}/search?type=${encodeURIComponent(subject.type)}`,
          },
          {
            '@type': 'ListItem',
            position: 3,
            name: label,
            item: url,
          },
        ],
      },
    ],
  ]);
  // fromEntries also preserves hostile property names such as __proto__ as ordinary own keys.
  return Object.fromEntries(entries);
}

/** Describe the localized site home and its search entry point. */
export function homeJsonLd({ origin, locale }: { origin: string; locale: string }): Record<string, JsonValue> {
  const site = origin.replace(/\/+$/, '');
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'REZICS',
    alternateName: 'rezics.com',
    url: `${site}/${encodeURIComponent(locale)}`,
    inLanguage: locale,
    potentialAction: {
      '@type': 'SearchAction',
      target: `${site}/${encodeURIComponent(locale)}/search?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  };
}

/** Escape HTML-sensitive characters while preserving the JSON value exactly. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
