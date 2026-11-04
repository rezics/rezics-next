const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function copiesSubjectId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length === 36 && uuid.test(value) ? value : undefined;
}

/** Keep the requested operands until address admission; invalid input must never become an unfiltered read. */
export type CopiesQuery = { subjectId?: unknown; kind?: unknown; status?: unknown; cursor?: unknown };
export function copiesQuery(input: unknown): CopiesQuery {
  if (!input || typeof input !== 'object') return {};
  const record = input as Record<string, unknown>;
  return {
    ...(record.subjectId !== undefined ? { subjectId: record.subjectId } : {}),
    ...(record.kind !== undefined ? { kind: record.kind } : {}),
    ...(record.status !== undefined ? { status: record.status } : {}),
    ...(record.cursor !== undefined ? { cursor: record.cursor } : {}),
  };
}

export type CopiesAddress = {
  subjectId: string | null;
  kind: string | null;
  status: string | null;
  cursor: string | null;
  locale: string;
  issue?: 'subject' | 'kind' | 'status' | 'cursor';
};
const absent = (value: unknown) => value === undefined || value === '';
const requestedText = (value: unknown): string | null =>
  absent(value) ? null : typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
const requestedFilter = (value: unknown): string | null =>
  value === undefined ? null : typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
const vocabularyId = /^[a-z][a-z0-9_.-]{0,63}(?![\s\S])/;
const invalidVocabulary = (value: unknown) =>
  value !== undefined && (typeof value !== 'string' || !vocabularyId.test(value));

export function copiesAddress(input: unknown, locale: string): CopiesAddress {
  const query = copiesQuery(input);
  const issue =
    !absent(query.subjectId) && !copiesSubjectId(query.subjectId)
      ? 'subject'
      : invalidVocabulary(query.kind)
        ? 'kind'
        : invalidVocabulary(query.status)
          ? 'status'
          : !absent(query.cursor) && (typeof query.cursor !== 'string' || query.cursor.length > 2048)
            ? 'cursor'
            : undefined;
  return {
    subjectId: requestedText(query.subjectId),
    kind: requestedFilter(query.kind),
    status: requestedFilter(query.status),
    cursor: requestedText(query.cursor),
    locale,
    ...(issue ? { issue } : {}),
  };
}
export function sameCopiesAddress(a: CopiesAddress, b: CopiesAddress): boolean {
  return (
    a.subjectId === b.subjectId &&
    a.kind === b.kind &&
    a.status === b.status &&
    a.cursor === b.cursor &&
    a.locale === b.locale &&
    a.issue === b.issue
  );
}
