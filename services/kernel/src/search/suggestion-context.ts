import { Buffer } from 'node:buffer';
import { isCalendarDate } from '@rezics/filter';
import { ProblemError } from '../http/problem.ts';

export type SuggestionContextLabel = Readonly<{ value: string; language: string }>;

export type SuggestionContextDate =
  | Readonly<{ state: 'value'; property: string; value: string; precision: 'year' | 'month' | 'day' }>
  | Readonly<{
      state: 'unknown' | 'no_value' | 'withheld' | 'unavailable' | 'not_applicable';
      property: string;
    }>;

export type SuggestionWorkContext =
  | Readonly<{
      subjectId: string;
      status: 'available';
      creator: Readonly<{
        id: string;
        label: SuggestionContextLabel;
        property: string;
        role: SuggestionContextLabel;
      }>;
      relation?: Readonly<{
        kind: 'work' | 'release';
        id: string;
        label: SuggestionContextLabel;
        date?: SuggestionContextDate;
      }>;
      /** Disclosed producer overflow only; it supplies no destination or count. */
      overflow?: boolean;
    }>
  | Readonly<{
      subjectId: string;
      status: 'absent' | 'not_applicable' | 'empty' | 'withheld' | 'unavailable';
    }>;

export type SuggestionWorkContextSnapshot = Readonly<{
  contexts: readonly SuggestionWorkContext[];
  /** Rechecks the producer's source identity, disclosure and release after response completion. */
  isCurrent(): Promise<boolean>;
}>;

export type SuggestionWorkContextReader = (
  input: Readonly<{
    subjectIds: readonly string[];
    languages: readonly string[];
    deadline: number;
  }>,
) => Promise<SuggestionWorkContextSnapshot>;

export const SUGGESTION_CONTEXT_LIMITS = Object.freeze({ subjects: 10, serializedBytes: 16_384 });

type SuggestionPage<T> = Readonly<{ subjects: readonly T[]; as_of: string }>;
type ContextualSubject<T> = T & Readonly<{ workContext: SuggestionWorkContext }>;
type ContextualSuggestionPage<T> = Readonly<{ subjects: ContextualSubject<T>[]; as_of: string }>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = (subjectId: string): SuggestionWorkContext => ({ subjectId, status: 'unavailable' });

function malformed(): never {
  throw new ProblemError('index_not_ready');
}

function changed(): never {
  throw new ProblemError('search_restart_required');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function validLabel(value: unknown): value is SuggestionContextLabel {
  return (
    record(value) &&
    exact(value, ['value', 'language']) &&
    typeof value.value === 'string' &&
    value.value.trim().length > 0 &&
    [...value.value].length <= 256 &&
    typeof value.language === 'string' &&
    value.language.length > 0 &&
    value.language.length <= 35
  );
}

function validProperty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= 128;
}

function validDateValue(value: unknown, precision: 'year' | 'month' | 'day'): value is string {
  if (typeof value !== 'string') return false;
  if (precision === 'year') return /^\d{4}$/.test(value) && isCalendarDate({ year: Number(value) });
  const month = /^(\d{4})-(\d{2})$/.exec(value);
  if (precision === 'month') return !!month && isCalendarDate({ year: Number(month[1]), month: Number(month[2]) });
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!day) return false;
  const year = Number(day[1]);
  const monthNumber = Number(day[2]);
  const dayNumber = Number(day[3]);
  return isCalendarDate({ year, month: monthNumber, day: dayNumber });
}

function validDate(value: unknown): value is SuggestionContextDate {
  if (!record(value) || typeof value.property !== 'string' || !validProperty(value.property)) return false;
  if (value.state === 'value') {
    return (
      exact(value, ['state', 'property', 'value', 'precision']) &&
      (value.precision === 'year' || value.precision === 'month' || value.precision === 'day') &&
      validDateValue(value.value, value.precision)
    );
  }
  return (
    exact(value, ['state', 'property']) &&
    ['unknown', 'no_value', 'withheld', 'unavailable', 'not_applicable'].includes(String(value.state))
  );
}

function validContext(value: unknown, subjectId: string): value is SuggestionWorkContext {
  if (!record(value) || value.subjectId !== subjectId || typeof value.status !== 'string') return false;
  if (value.status !== 'available')
    return (
      exact(value, ['subjectId', 'status']) &&
      ['absent', 'not_applicable', 'empty', 'withheld', 'unavailable'].includes(value.status)
    );
  if (!exact(value, ['subjectId', 'status', 'creator'], ['relation', 'overflow'])) return false;

  const creator = value.creator;
  if (
    !record(creator) ||
    !exact(creator, ['id', 'label', 'property', 'role']) ||
    typeof creator.id !== 'string' ||
    !uuid.test(creator.id) ||
    !validLabel(creator.label) ||
    !validProperty(creator.property) ||
    !validLabel(creator.role)
  )
    return false;

  if (value.relation !== undefined) {
    const relation = value.relation;
    if (
      !record(relation) ||
      !exact(relation, ['kind', 'id', 'label'], ['date']) ||
      (relation.kind !== 'work' && relation.kind !== 'release') ||
      typeof relation.id !== 'string' ||
      !uuid.test(relation.id) ||
      !validLabel(relation.label) ||
      (relation.date !== undefined && !validDate(relation.date))
    )
      return false;
  }

  if (value.overflow !== undefined) {
    const overflow = value.overflow;
    if (typeof overflow !== 'boolean' || overflow !== true) return false;
  }
  return true;
}

function unavailablePage(subjectIds: readonly string[]) {
  return {
    contexts: subjectIds.map(unavailable),
    async isCurrent() {
      return true;
    },
  } satisfies SuggestionWorkContextSnapshot;
}

async function readContexts(
  subjectIds: readonly string[],
  options: Readonly<{
    reader?: SuggestionWorkContextReader;
    languages: readonly string[];
    deadline: number;
  }>,
): Promise<SuggestionWorkContextSnapshot> {
  if (!options.reader || !subjectIds.length) return unavailablePage(subjectIds);

  let snapshot: SuggestionWorkContextSnapshot;
  try {
    snapshot = await options.reader({
      subjectIds: [...subjectIds],
      languages: [...options.languages],
      deadline: options.deadline,
    });
  } catch (error) {
    if (error instanceof ProblemError && ['index_not_ready', 'search_restart_required'].includes(error.code))
      throw error;
    return unavailablePage(subjectIds);
  }

  if (!record(snapshot) || !Array.isArray(snapshot.contexts) || typeof snapshot.isCurrent !== 'function') malformed();
  if (snapshot.contexts.length > SUGGESTION_CONTEXT_LIMITS.subjects) malformed();

  const allowed = new Set(subjectIds.map((id) => id.toLowerCase()));
  const contexts = new Map<string, SuggestionWorkContext>();
  for (const context of snapshot.contexts) {
    if (!record(context) || typeof context.subjectId !== 'string') malformed();
    const key = context.subjectId.toLowerCase();
    if (!allowed.has(key) || contexts.has(key) || !validContext(context, context.subjectId)) malformed();
    contexts.set(key, context);
  }

  const ordered = subjectIds.map((id) => contexts.get(id.toLowerCase()) ?? unavailable(id));
  if (Buffer.byteLength(JSON.stringify(ordered), 'utf8') > SUGGESTION_CONTEXT_LIMITS.serializedBytes)
    return unavailablePage(subjectIds);

  return {
    contexts: ordered,
    async isCurrent() {
      try {
        if (!(await snapshot.isCurrent())) changed();
      } catch (error) {
        if (error instanceof ProblemError && error.code === 'search_restart_required') throw error;
        changed();
      }
      return true;
    },
  };
}

/** Compose one bounded optional context batch, complete the normal summary read, then recheck both owners. */
export async function completeSuggestionWorkContext<T extends Readonly<{ id: string }>>(
  page: SuggestionPage<T>,
  options: Readonly<{
    reader?: SuggestionWorkContextReader;
    languages: readonly string[];
    deadline: number;
    complete?: (page: ContextualSuggestionPage<T>) => Promise<void>;
    verifyCurrent?: () => Promise<boolean>;
  }>,
): Promise<ContextualSuggestionPage<T>> {
  if (
    page.subjects.length > SUGGESTION_CONTEXT_LIMITS.subjects ||
    new Set(page.subjects.map(({ id }) => id.toLowerCase())).size !== page.subjects.length ||
    page.subjects.some(({ id }) => !uuid.test(id))
  )
    changed();

  const snapshot = await readContexts(
    page.subjects.map(({ id }) => id),
    {
      ...(options.reader ? { reader: options.reader } : {}),
      languages: options.languages,
      deadline: options.deadline,
    },
  );
  const contextual: ContextualSuggestionPage<T> = {
    ...page,
    subjects: page.subjects.map((subject, index) => ({ ...subject, workContext: snapshot.contexts[index]! })),
  };
  await options.complete?.(contextual);
  if (options.verifyCurrent && !(await options.verifyCurrent())) changed();
  await snapshot.isCurrent();
  return contextual;
}
