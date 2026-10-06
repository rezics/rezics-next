import type { CopyState, LibraryParty } from '../library/copies.ts';
import type { LoanState } from '../library/loans.ts';

const party = (value: LibraryParty) => value.kind === 'person'
  ? { '@id': value.person, '@type': 'Person' } : { name: value.name };

/** schema.org carries portable ownership/action meaning; the native state in
 * the bundle retains format, acquisition time, return time, revision and tombstones.
 * A free-text counterparty is a name-only node, never a resolved Person. */
export function ownershipJsonLd(copy: CopyState) {
  return { '@context': 'https://schema.org', '@type': 'OwnershipInfo',
    '@id': `urn:rezics:ownership:${copy.id.slice(-36)}`,
    typeOfGood: { '@id': copy.id, '@type': 'Product', isBasedOn: { '@id': copy.release },
      ...(copy.format ? { additionalProperty: { '@type': 'PropertyValue', name: 'format', value: copy.format } } : {}) },
    ...(copy.acquiredFrom ? { acquiredFrom: party(copy.acquiredFrom) } : {}),
    ...(copy.ownedFrom ? { ownedFrom: copy.ownedFrom } : {}),
    ...(copy.ownedThrough ? { ownedThrough: copy.ownedThrough } : {}) };
}

export function loanJsonLd(loan: LoanState, agent: string) {
  return { '@context': { '@vocab': 'https://schema.org/', rezics: 'https://rezics.com/vocab/' },
    '@id': loan.id, '@type': loan.direction === 'lent' ? 'LendAction' : 'BorrowAction',
    agent: { '@id': agent }, object: { '@id': loan.copy },
    ...(loan.direction === 'lent' ? { borrower: party(loan.counterparty) } : { lender: party(loan.counterparty) }),
    startTime: loan.startedAt, endTime: loan.dueAt,
    actionStatus: { '@id': `https://schema.org/${loan.returnedAt ? 'Completed' : 'Active'}ActionStatus` },
    ...(loan.returnedAt ? { 'rezics:returnedAt': loan.returnedAt } : {}) };
}
