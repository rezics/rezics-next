import { t } from 'elysia';
import { exactContentRevision } from '../../api-responses.ts';
import { pageFields, readId, readLanguage, readPosition } from '../work/read-contract.ts';

const contentRevision = t.String({ pattern: '^urn:rezics:content:revision:[0-9a-f-]{36}$' });
export const contentsQuery = t.Object({ version: t.Optional(readId), language: t.Optional(readLanguage),
  parent: t.Optional(readId), actingSubject: t.Optional(readId),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
  cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })) }, { additionalProperties: false });
export const chapterQuery = t.Object({ revision: t.Optional(readId), language: t.Optional(readLanguage),
  actingSubject: t.Optional(readId) }, { additionalProperties: false });
const label = t.Object({ value: t.String(), language: t.String() });
const progress = t.Object({ composition: readId, occurrence: readId,
  selectedRevision: contentRevision });
/** How a group divides the Book; a group that does not say reads as a part. Null for a chapter. */
const division = t.Nullable(t.Union([t.Literal('volume'), t.Literal('part'), t.Literal('extras')]));
export const contentsItem = t.Object({ occurrence: readId, parent: readId,
  role: t.Union([t.Literal('group'), t.Literal('chapter')]),
  label: t.Nullable(label), division,
  /**
   * A volume's number among the Book's volumes, or a story chapter's number through the
   * whole Book; null for parts, for chapters in extras, and past the numbering budget.
   */
  number: t.Nullable(t.Integer({ minimum: 1 })),
  /** A group's active children; null for a chapter. */
  childCount: t.Nullable(t.Integer({ minimum: 0 })),
  target: t.Nullable(readId),
  selectedRevision: t.Nullable(contentRevision),
  progress: t.Nullable(progress),
  availability: t.Union([t.Literal('available'), t.Literal('unavailable')]) });
export const contentsPage = t.Object({ profile: t.Literal('work-contents-v1'), work: readId,
  version: readId, composition: readId, compositionRevision: readId,
  language: t.Nullable(readLanguage), items: t.Array(contentsItem, { maxItems: 20 }), ...pageFields });
export const chapterRead = t.Object({ profile: t.Literal('work-chapter-v1'), work: readId,
  version: readId, composition: readId, compositionRevision: readId, occurrence: readId,
  parent: readId, parentPath: t.Array(t.Object({ occurrence: readId, label: t.Nullable(label),
    division, number: t.Nullable(t.Integer({ minimum: 1 })) }), { maxItems: 16 }),
  ordinal: t.Integer({ minimum: 1 }),
  /** The chapter's story number through the Book, as on Contents items. */
  number: t.Nullable(t.Integer({ minimum: 1 })), label: t.Nullable(label),
  language: readLanguage, selectedRevision: contentRevision,
  progress,
  previous: t.Nullable(readId), next: t.Nullable(readId),
  content: exactContentRevision, sourcePosition: readPosition });

/**
 * One parent page, one exact body; no descendant flattening or unbounded sibling walk.
 * Numbering reads the Book's top-level groups once (at most `topGroups`), and each
 * page counts its groups' children with two order-tree descents per group.
 */
export const WORK_CONTENTS_COST = { pageSize: 20, bodyBytes: 1024 * 1024,
  navigationCandidates: 20, legacyTitleBatch: 4, legacyTitleOwnerCalls: 5, topGroups: 200 } as const;
