import { Value } from 'typebox/value';
import { releaseIdentifier } from '../release/schema.ts';
import type { CanonicalRow } from './formats/contract.ts';
import type { ReleaseLookup } from '../release/read.ts';

interface IdentifierMapping {
  grain: 'work' | 'release';
  lookup: 'isbn13' | 'qualified';
  searches: readonly string[];
}

/** Reviewed 2026-10-16. Catalogue identifiers are evidence of identity, not
 * permission to acquire a different provider's record by title. Unlisted
 * provider-qualified identifiers retain Work grain until explicitly reviewed. */
export const LIBRARY_IDENTIFIER_MAPPINGS: Readonly<Record<string, IdentifierMapping>> = {
  isbn13: { grain: 'release', lookup: 'isbn13', searches: ['open-library'] },
  'https://vndb.org/vn': { grain: 'work', lookup: 'qualified', searches: [] },
  'https://myanimelist.net/anime': { grain: 'work', lookup: 'qualified', searches: [] },
  'https://myanimelist.net/manga': { grain: 'work', lookup: 'qualified', searches: [] },
};
const qualified: IdentifierMapping = { grain: 'work', lookup: 'qualified', searches: [] };
export const LIBRARY_TITLE_SEARCHES = ['open-library'] as const;

export function libraryIdentifier(identifier: { provider: string; value: string }):
  { mapping: IdentifierMapping; lookup: ReleaseLookup } | null {
  const mapping = LIBRARY_IDENTIFIER_MAPPINGS[identifier.provider] ?? qualified;
  if (mapping.lookup === 'isbn13') return { mapping, lookup: { isbn13: identifier.value } };
  if (!Value.Check(releaseIdentifier, identifier)) return null;
  return { mapping, lookup: { provider: identifier.provider, identifier: identifier.value } };
}

/** The reviewed acquisition mapping currently has one HTTP adapter. Identifiers
 * from other catalogues still use native lookup and never authorize an
 * unrelated title acquisition. */
export function librarySourceQueries(row: CanonicalRow, actingSubject: string) {
  const identifiers = row.identifiers.flatMap(identifier => {
    const admitted = libraryIdentifier(identifier);
    return admitted ? [admitted] : [];
  });
  const eligible = row.identifiers.length === 0 ? LIBRARY_TITLE_SEARCHES : identifiers.flatMap(i => i.mapping.searches);
  if (!eligible.includes('open-library')) return [];
  const isbn = identifiers.find(i => i.mapping.lookup === 'isbn13')?.lookup.isbn13;
  return [...(isbn ? [{ actingSubject, isbn }] : []), { actingSubject, title: row.title.slice(0,200),
    ...(row.creators[0] ? { author: row.creators[0].slice(0,200) } : {}) }];
}
