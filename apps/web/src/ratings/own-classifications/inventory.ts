import type { ClassificationFrontier, ClassificationKey, OwnClassificationsPage } from './types';

export const OWN_CLASSIFICATIONS_OPERATION = 'classification_ballot.own_page';
export const OWN_CLASSIFICATIONS_SOURCE = 'content.classification-ballot-own-page.v1';
export const OWN_CLASSIFICATIONS_PATH = '/library/classification-assessments';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** No trimming or decoding: the native cursor is an opaque frontier, not a Web pagination token. */
export function classificationFrontier(value: Record<string, unknown>): ClassificationFrontier | null {
  const { cursor, selectedSubjectId, selectedAssociationId } = value;
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 4096)) return null;
  if ((selectedSubjectId === undefined) !== (selectedAssociationId === undefined)) return null;
  if (
    selectedSubjectId !== undefined &&
    (typeof selectedSubjectId !== 'string' ||
      !uuid.test(selectedSubjectId) ||
      typeof selectedAssociationId !== 'string' ||
      !uuid.test(selectedAssociationId))
  )
    return null;
  return {
    cursor: typeof cursor === 'string' ? cursor : null,
    selected:
      typeof selectedSubjectId === 'string' && typeof selectedAssociationId === 'string'
        ? { subjectId: selectedSubjectId, associationId: selectedAssociationId }
        : null,
  };
}

export function classificationPair(key: ClassificationKey): string {
  return `${key.subjectId}:${key.associationId}`;
}

export function classificationSearch(frontier: ClassificationFrontier) {
  return {
    ...(frontier.cursor === null ? {} : { cursor: frontier.cursor }),
    ...(frontier.selected
      ? {
          selectedSubjectId: frontier.selected.subjectId,
          selectedAssociationId: frontier.selected.associationId,
        }
      : {}),
  };
}

/** Page replacement only. Selected promotion and omission belong to Content; never refill or deduplicate. */
export function indexOwnClassifications(page: OwnClassificationsPage, frontier: ClassificationFrontier) {
  if (
    page.items.length > (frontier.selected ? 21 : 20) ||
    (page.next !== null && (page.next.length === 0 || page.next.length > 4096)) ||
    (page.traversal === 'more') !== (page.next !== null)
  )
    throw new Error('Invalid classification frontier');
  const result = new Map<string, OwnClassificationsPage['items'][number]>();
  for (const row of page.items) {
    const key = classificationPair(row);
    if (result.has(key)) throw new Error('Duplicate original classification key');
    if (
      row.state === 'available' &&
      (row.association.subjectId !== row.subjectId ||
        row.association.associationId !== row.associationId ||
        row.target.id !== row.association.targetId)
    )
      throw new Error('Mismatched original classification key');
    result.set(key, row);
  }
  if (page.items.length === 21 && (!frontier.selected || !result.has(classificationPair(frontier.selected))))
    throw new Error('Missing promoted classification key');
  return result;
}
