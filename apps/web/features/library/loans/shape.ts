import { momentText } from '../format.ts';
import type { CopyRecord, LibraryParty, LoanRecord, RecordPage, ReleaseChoice } from './types.ts';

export function asParty(value: unknown): LibraryParty | null {
  if (!value || typeof value !== 'object') return null;
  const party = value as { kind?: unknown; name?: unknown; person?: unknown };
  if (party.kind === 'name' && typeof party.name === 'string') return { kind: 'name', name: party.name };
  if (party.kind === 'person' && typeof party.person === 'string') return { kind: 'person', person: party.person };
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function instant(value: unknown): string | null {
  return momentText(value);
}

export function asCopy(value: unknown): CopyRecord | null {
  if (!value || typeof value !== 'object') return null;
  const copy = value as Record<string, unknown>;
  const changedAt = instant(copy.changedAt);
  if (typeof copy.id !== 'string' || typeof copy.work !== 'string' || typeof copy.release !== 'string'
    || typeof copy.version !== 'number' || !changedAt || typeof copy.removed !== 'boolean') return null;
  const acquiredFrom = copy.acquiredFrom === null ? null : asParty(copy.acquiredFrom);
  if (copy.acquiredFrom !== null && !acquiredFrom) return null;
  return { id: copy.id, work: copy.work, release: copy.release, format: text(copy.format),
    acquiredFrom, acquiredAt: instant(copy.acquiredAt), ownedFrom: instant(copy.ownedFrom),
    ownedThrough: instant(copy.ownedThrough), removed: copy.removed, version: copy.version, changedAt };
}

export function asLoan(value: unknown): LoanRecord | null {
  if (!value || typeof value !== 'object') return null;
  const loan = value as Record<string, unknown>;
  const counterparty = asParty(loan.counterparty);
  const startedAt = instant(loan.startedAt);
  const dueAt = instant(loan.dueAt);
  const changedAt = instant(loan.changedAt);
  if (typeof loan.id !== 'string' || typeof loan.copy !== 'string' || !counterparty || !startedAt || !dueAt
    || !changedAt || typeof loan.version !== 'number'
    || (loan.direction !== 'lent' && loan.direction !== 'borrowed')
    || (loan.state !== 'open' && loan.state !== 'overdue' && loan.state !== 'returned')) return null;
  return { id: loan.id, copy: loan.copy, direction: loan.direction, counterparty, startedAt, dueAt,
    returnedAt: loan.returnedAt === null ? null : instant(loan.returnedAt), version: loan.version, changedAt,
    state: loan.state };
}

export function asPage<T>(value: unknown, item: (value: unknown) => T | null): RecordPage<T> | null {
  if (!value || typeof value !== 'object') return null;
  const page = value as { items?: unknown; nextCursor?: unknown; complete?: unknown };
  if (!Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) return null;
  // Copies and loans say `complete`. A public edition page only sends the next cursor.
  const complete = typeof page.complete === 'boolean' ? page.complete : page.nextCursor === null;
  const items: T[] = [];
  for (const entry of page.items) {
    const parsed = item(entry);
    if (!parsed) return null;
    items.push(parsed);
  }
  return { items, nextCursor: page.nextCursor, complete };
}

export function asRelease(value: unknown): ReleaseChoice | null {
  if (!value || typeof value !== 'object') return null;
  const release = value as { id?: unknown; title?: { value?: unknown }; editionStatement?: unknown;
    publicationYear?: unknown; isbn13?: unknown };
  if (typeof release.id !== 'string' || typeof release.title?.value !== 'string') return null;
  return { id: release.id, title: release.title.value, editionStatement: text(release.editionStatement),
    publicationYear: typeof release.publicationYear === 'number' ? release.publicationYear : null,
    isbn13: text(release.isbn13) };
}
