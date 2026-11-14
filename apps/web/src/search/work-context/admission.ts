type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string';
}

function labels(value: unknown): boolean {
  return record(value) && Object.values(value).every(text);
}

function term(value: unknown): boolean {
  return record(value) && text(value.id) && labels(value.labels);
}

function unavailable(value: RecordValue): boolean {
  return value.state === 'unavailable' && ['native', 'limit', 'response_limit'].includes(String(value.reason));
}

function workValue(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.state === 'somevalue' || value.state === 'novalue' || value.state === 'unsupported') return true;
  if (value.state !== 'value') return false;
  switch (value.kind) {
    case 'item':
      return text(value.id) && text(value.originalId) && term(value.type) && labels(value.labels);
    case 'text':
      return text(value.text);
    case 'quantity':
      return text(value.amount) && text(value.unit);
    case 'time':
      return (
        value.calendar === 'gregorian' &&
        Number.isInteger(value.year) &&
        (value.month === undefined || Number.isInteger(value.month)) &&
        (value.day === undefined || Number.isInteger(value.day))
      );
    default:
      return false;
  }
}

function qualifierSection(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.state === 'empty' || value.state === 'withheld' || value.state === 'unsupported' || unavailable(value))
    return true;
  return (
    value.state === 'current' &&
    Array.isArray(value.items) &&
    value.items.every((item) => record(item) && term(item.property) && workValue(item.value))
  );
}

function statement(value: unknown): boolean {
  return (
    record(value) &&
    text(value.statementId) &&
    text(value.sourceId) &&
    value.direction === 'outgoing' &&
    term(value.property) &&
    Number.isInteger(value.revision) &&
    text(value.release) &&
    (value.rank === 'normal' || value.rank === 'preferred') &&
    workValue(value.value) &&
    qualifierSection(value.qualifiers)
  );
}

function workSection(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.state === 'empty' || value.state === 'withheld' || value.state === 'unsupported' || unavailable(value))
    return true;
  return (
    value.state === 'current' &&
    Array.isArray(value.items) &&
    typeof value.overflow === 'boolean' &&
    value.items.every(statement)
  );
}

/** Structural admission follows the installed WorkContext union; the kernel HTTP route owns its closed wire checks. */
export function isWorkContextShape(value: unknown): boolean {
  if (!record(value)) return false;
  if (unavailable(value)) return true;
  return (
    value.state === 'current' &&
    text(value.subjectId) &&
    term(value.type) &&
    (value.kind === 'work' || value.kind === 'release' || value.kind === 'recording') &&
    workSection(value.creators) &&
    workSection(value.relations) &&
    workSection(value.dates)
  );
}

/** An optional context can be retired without making its independently admitted hit unusable. */
export function admitWorkContext<
  T extends { state: 'unavailable' } | { state: 'current'; subjectId: string; type: { id: string } },
>(context: T, subject: { id: string; type: string; creativeWork: boolean }): T | undefined {
  if (!subject.creativeWork) return undefined;
  if (context.state === 'current' && (context.subjectId !== subject.id || context.type.id !== subject.type))
    return undefined;
  return context;
}
