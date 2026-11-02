/** Mirrors the native Collection text contract without normalizing command operands. */
export const collectionTextLimits = { title: 200, description: 2000, note: 1000 } as const;
export type CollectionTextField = keyof typeof collectionTextLimits;
export type CollectionTextIssue = 'required' | 'limit' | 'nul';

export function collectionTextIssue(field: CollectionTextField, value: string | null): CollectionTextIssue | null {
  if (field === 'title' && (value === null || value === '')) return 'required';
  if (value === null) return null;
  if (value.includes('\0')) return 'nul';
  return Array.from(value).length > collectionTextLimits[field] ? 'limit' : null;
}
