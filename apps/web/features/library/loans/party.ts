import type { LibraryParty } from './types.ts';

/**
 * What the reader chose to store. A name is kept character for character
 * after trimming the ends, including when a person was also looked up:
 * choosing "A name" never turns that text into a profile.
 */
export function partyFromInput(input: { mode: 'name' | 'person'; name: string; personId: string | null }):
  LibraryParty | null {
  if (input.mode === 'name') {
    const name = input.name.trim();
    return name ? { kind: 'name', name } : null;
  }
  return input.personId ? { kind: 'person', person: input.personId } : null;
}

/**
 * The label on a loan. A stored name is shown as written. A person uses the
 * profile name from a separate read, never a search of that name.
 */
export function counterpartyLabel(party: LibraryParty, personName: string | null, unnamedPerson: string): string {
  if (party.kind === 'name') return party.name;
  return personName ?? unnamedPerson;
}

export function sameParty(left: LibraryParty | null, right: LibraryParty | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === 'name' && right.kind === 'name') return left.name === right.name;
  return left.kind === 'person' && right.kind === 'person' && left.person === right.person;
}
export function handleText(value: string): string {
  return value.trim().replace(/^@+/, '').trim();
}
