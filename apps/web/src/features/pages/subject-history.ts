import { isView } from '@rezics/composition';
import { subjectHref, subjectViewHref } from '../../subject/subject-href';
import { countFromLinks, type Count } from '../count';
import { subjectVisitReturn, withSubjectVisitReturn } from './subject-visit-navigation';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const nodePattern = /^[A-Za-z0-9_-]{1,64}$/;
const locales = new Set(['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es']);

export type RelationHistoryDirection = 'forward' | 'inverse';

/** Exact current relation window. Cursor is the opaque native continuation, never a reconstructed offset. */
export type RelationHistorySelection = {
  subject: string;
  label: string;
  locale: string;
  view: string;
  node: string;
  property: string;
  direction: RelationHistoryDirection;
  cursor: string | null;
};

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

function validProperty(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function validCursor(value: unknown): value is string {
  return typeof value === 'string' && !!value && value.length <= 8192 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Admit only the current node, property, direction and cursor. Unknown or extra fields refuse the selection. */
export function admitRelationHistorySelection(input: unknown): RelationHistorySelection | undefined {
  const value = record(input);
  if (!value) return;
  const keys = Object.keys(value);
  if (
    keys.length < 7 ||
    keys.length > 8 ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !['subject', 'label', 'locale', 'view', 'node', 'property', 'direction', 'cursor'].includes(key))
  )
    return;
  const { subject, label, locale, view, node, property, direction, cursor } = value;
  if (
    typeof subject !== 'string' ||
    !uuid.test(subject) ||
    typeof label !== 'string' ||
    label.length > 512 ||
    typeof locale !== 'string' ||
    !locales.has(locale) ||
    typeof view !== 'string' ||
    !isView(view) ||
    typeof node !== 'string' ||
    !nodePattern.test(node) ||
    !validProperty(property) ||
    (direction !== 'forward' && direction !== 'inverse') ||
    (cursor !== undefined && cursor !== null && !validCursor(cursor))
  )
    return;
  return {
    subject,
    label,
    locale,
    view,
    node,
    property,
    direction,
    cursor: typeof cursor === 'string' ? cursor : null,
  };
}

export function sameRelationHistorySelection(
  initial: RelationHistorySelection,
  next: RelationHistorySelection,
): boolean {
  return (
    initial.subject === next.subject &&
    initial.locale === next.locale &&
    initial.view === next.view &&
    initial.node === next.node &&
    initial.property === next.property &&
    initial.direction === next.direction &&
    initial.cursor === next.cursor
  );
}

/** Public relation address for retry and return. Direction is the native stream, not a reconstructed inverse. */
export function relationHistoryHref(selection: RelationHistorySelection): string | undefined {
  const admitted = admitRelationHistorySelection(selection);
  if (!admitted) return;
  const query = new URLSearchParams({
    node: admitted.node,
    property: admitted.property,
    streamProperty: admitted.property,
    streamDirection: admitted.direction,
    ...(admitted.cursor ? { cursor: admitted.cursor } : {}),
  });
  const href = subjectViewHref(
    { id: admitted.subject, label: admitted.label },
    admitted.locale,
    admitted.view,
    `?${query}`,
  );
  return subjectVisitReturn(href, admitted.locale);
}

/** History visit that returns to the exact relation window. */
export function relationHistoryChangesHref(selection: RelationHistorySelection): string | undefined {
  const origin = relationHistoryHref(selection);
  if (!origin) return;
  const changes = `${subjectHref({ id: selection.subject, label: selection.label }, selection.locale).href}/changes`;
  const href = withSubjectVisitReturn(changes, origin, selection.locale);
  return href.includes('via=') ? href : undefined;
}

/** Restart drops the opaque cursor and keeps the same node, property and direction. */
export function relationHistoryRestartHref(selection: RelationHistorySelection): string | undefined {
  return relationHistoryHref({ ...selection, cursor: null });
}

/** Omitted native counts stay unknown. Returned length is never a substitute total. */
export function relationHistoryCount(
  count: { value: number; exact: boolean } | undefined,
  returned: number,
): Count | undefined {
  return countFromLinks(count, returned);
}
