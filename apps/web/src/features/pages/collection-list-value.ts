import { isRecord } from './shared';

type CollectionRow = {
  id: string;
  title: string;
  multiplicity: number;
  curator?: { displayName: string | null; handle: string | null } | null | undefined;
};

type CollectionListValue = {
  collections: CollectionRow[];
  count: { value: number; exact: true };
  next: string | null;
};

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function collectionRow(value: unknown): value is CollectionRow {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.multiplicity !== 'number' ||
    !Number.isInteger(value.multiplicity) ||
    value.multiplicity < 1
  )
    return false;
  const curator = value.curator;
  return (
    curator === undefined ||
    curator === null ||
    (isRecord(curator) && nullableText(curator.displayName) && nullableText(curator.handle))
  );
}

/** Admit the consumed fields of collection-routes' fullSubjectPage before hiding or slicing any rows. */
export function collectionListValue(body: unknown): CollectionListValue | undefined {
  if (
    !isRecord(body) ||
    !Array.isArray(body.collections) ||
    !isRecord(body.count) ||
    typeof body.count.value !== 'number' ||
    !Number.isInteger(body.count.value) ||
    body.count.value < 0 ||
    body.count.exact !== true ||
    !nullableText(body.next)
  )
    return;
  const collections: CollectionRow[] = [];
  for (const row of body.collections) {
    if (!collectionRow(row)) return;
    collections.push(row);
  }
  return { collections, count: { value: body.count.value, exact: true }, next: body.next };
}
