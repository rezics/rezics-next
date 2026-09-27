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
export const contentsItem = t.Object({ occurrence: readId, parent: readId,
  role: t.Union([t.Literal('group'), t.Literal('chapter')]),
  label: t.Nullable(label), target: t.Nullable(readId),
  selectedRevision: t.Nullable(contentRevision),
  progress: t.Nullable(progress),
  availability: t.Union([t.Literal('available'), t.Literal('unavailable')]) });
export const contentsPage = t.Object({ profile: t.Literal('work-contents-v1'), work: readId,
  version: readId, composition: readId, compositionRevision: readId,
  language: t.Nullable(readLanguage), items: t.Array(contentsItem, { maxItems: 20 }), ...pageFields });
export const chapterRead = t.Object({ profile: t.Literal('work-chapter-v1'), work: readId,
  version: readId, composition: readId, compositionRevision: readId, occurrence: readId,
  parent: readId, language: readLanguage, selectedRevision: contentRevision,
  progress,
  previous: t.Nullable(readId), next: t.Nullable(readId),
  content: exactContentRevision, sourcePosition: readPosition });

/** One parent page, one exact body; no descendant flattening or unbounded sibling walk. */
export const WORK_CONTENTS_COST = { pageSize: 20, bodyBytes: 1024 * 1024,
  navigationCandidates: 20 } as const;
