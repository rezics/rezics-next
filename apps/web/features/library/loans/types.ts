// Private copies and loans (`services/main/src/routes/library-copies.ts`).
// A free-text name stays a name; a person is a profile reference. The two are
// never inferred from each other.

export interface LibraryPartyName { kind: 'name'; name: string }
export interface LibraryPartyPerson { kind: 'person'; person: string }
export type LibraryParty = LibraryPartyName | LibraryPartyPerson;

export interface CopyRecord {
  id: string;
  work: string;
  release: string;
  format: string | null;
  acquiredFrom: LibraryParty | null;
  acquiredAt: string | null;
  ownedFrom: string | null;
  ownedThrough: string | null;
  removed: boolean;
  version: number;
  changedAt: string;
}

export interface LoanRecord {
  id: string;
  copy: string;
  direction: 'lent' | 'borrowed';
  counterparty: LibraryParty;
  startedAt: string;
  dueAt: string;
  returnedAt: string | null;
  version: number;
  changedAt: string;
  state: 'open' | 'overdue' | 'returned';
}

export interface ReleaseChoice {
  id: string;
  title: string;
  editionStatement: string | null;
  publicationYear: number | null;
  isbn13: string | null;
}

export interface PersonCard {
  id: string;
  displayName: string;
  handle: string | null;
  kind: string;
}

export interface RecordPage<T> {
  items: T[];
  nextCursor: string | null;
  complete: boolean;
}

/** Why a copy or loan write did not land. `moved` is a stale version; `conflict` is a rule such as an open loan. */
export type RecordFailure = 'moved' | 'conflict' | 'invalid' | 'missing' | 'sign-in' | 'unavailable';
export type RecordResult<T> = { ok: true; data: T } | { ok: false; failure: RecordFailure };

/** One loan as the list shows it. The work and edition are read from the copy; they are not on the loan itself. */
export interface LoanListItem {
  loan: LoanRecord;
  work: { id: string; href: string; title: string } | null;
  edition: string | null;
  format: string | null;
  /** The person's profile name when the counterparty is a person and the profile could be read. */
  personName: string | null;
}

export interface CopyDraft {
  release: string;
  format: string | null;
  acquiredFrom: LibraryParty | null;
  acquiredAt: string | null;
  ownedFrom: string | null;
}

export interface LoanDraft {
  copy: string;
  direction: 'lent' | 'borrowed';
  counterparty: LibraryParty;
  startedAt: string;
  dueAt: string;
}
