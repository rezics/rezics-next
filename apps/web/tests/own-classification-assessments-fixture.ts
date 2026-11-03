import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import type { OwnClassification, OwnClassificationsPage } from '../src/ratings/own-classifications/types';

export const accountId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702001';
export const subjectId = '00000000-0000-8000-8000-000000000010';
export const associationId = '00000000-0000-8000-8000-000000000011';
export const targetId = '00000000-0000-8000-8000-000000000012';
export const frontier = { cursor: null, selected: null };
export function classificationRow(index = 0): OwnClassification {
  const id = index === 0 ? associationId : `00000000-0000-8000-8000-${String(index + 100).padStart(12, '0')}`;
  const path = `/v1/subjects/${subjectId}/classification-associations/${id}/assessment`;
  return {
    state: 'available',
    subjectId,
    associationId: id,
    subject: { id: subjectId, type: 'schema:Book', label: 'Own-page subject', href: `/v1/subjects/${subjectId}` },
    target: { id: targetId, type: 'skos:Concept', label: 'Own-page concept', href: `/v1/subjects/${targetId}` },
    association: {
      subjectId,
      associationId: id,
      targetId,
      slotId: id,
      property: 'schema:keywords',
      contextId: PAGE_GLOBAL_CONTEXT,
      origin: 'global',
      release: 'release',
      revision: 1,
      bindingHash: 'ab'.repeat(32),
      statementDigest: 'cd'.repeat(32),
      qualifiersDigest: 'ef'.repeat(32),
    },
    own: { assessment: 'support', falsePositive: true, revision: '1', pending: 'pending' },
    aggregate: { associationId: id, state: 'suppressed', pending: 'unknown' },
    actions: {
      state: 'editable',
      readback: path,
      set: `${path}?expectedRevision=1`,
      clear: `${path}?expectedRevision=1`,
    },
  };
}
export function classificationsPage(items = [classificationRow()], next: string | null = null): OwnClassificationsPage {
  return {
    viewer: { accountId },
    inventory: { kind: 'current-retained', complete: false, generation: '1', cleanup: 'settled' },
    items,
    next,
    traversal: next === null ? 'complete' : 'more',
  };
}
