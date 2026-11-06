import { createContext } from 'react';

/** The exact slot an evidence window reads: the item's property, its target, and the slot key when it carries one. */
export type RelationEvidenceSlot = { property: string; target: string; key?: string | undefined };

/** Offered by a relation view to each item it shows; `undefined` means the item has no evidence window. */
export type RelationEvidenceLinks = { href(slot: RelationEvidenceSlot): string | undefined };

export const RelationEvidenceContext = createContext<RelationEvidenceLinks | undefined>(undefined);

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const curie = /^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9_.-]+$/;

/** The view's own address with only the evidence slot changed, so retry and return keep the view exact. */
export function relationEvidenceHref(current: string, slot: RelationEvidenceSlot): string | undefined {
  if (!curie.test(slot.property) || slot.property.length > 128 || !uuid.test(slot.target)) return;
  if (slot.key !== undefined && !uuid.test(slot.key)) return;
  const url = new URL(current, 'https://rezics.invalid');
  url.searchParams.set('evidence', slot.target);
  url.searchParams.set('evidenceProperty', slot.property);
  if (slot.key) url.searchParams.set('evidenceKey', slot.key);
  else url.searchParams.delete('evidenceKey');
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The view address without its evidence slot. */
export function relationEvidenceClose(current: string): string {
  const url = new URL(current, 'https://rezics.invalid');
  for (const key of ['evidence', 'evidenceProperty', 'evidenceKey']) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}`;
}
