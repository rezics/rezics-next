import { type PopulationEnvelope, type PopulationInput, type PopulationItem } from './subject-rating-populations';
import { admitRatingAggregate } from './rating-population-value';
import { GLOBAL, type Figure, type RatingOutcome } from './subject-ratings';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failureKinds = ['absent', 'unavailable', 'terminal', 'failed'] as const;
type WaitMetadata = { retryAfter?: string | number };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const keys = Object.keys(value);
  return (
    keys.length >= required.length &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function waitMetadata(value: Record<string, unknown>): WaitMetadata | null {
  if (!Object.prototype.hasOwnProperty.call(value, 'retryAfter')) return {};
  const retryAfter = value.retryAfter;
  return (typeof retryAfter === 'string' && retryAfter.length > 0) ||
    (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0)
    ? { retryAfter }
    : null;
}

function validRequest(input: PopulationInput): boolean {
  const selected = input.selected;
  return (
    uuid.test(input.id) &&
    uuid.test(input.question) &&
    (input.expectedReader === null || (typeof input.expectedReader === 'string' && input.expectedReader.length > 0)) &&
    (selected === undefined ||
      (Array.isArray(selected) &&
        selected.length <= 20 &&
        selected.every((id) => typeof id === 'string' && uuid.test(id) && id !== GLOBAL) &&
        new Set(selected).size === selected.length))
  );
}

function admitFailure(value: unknown): (Exclude<RatingOutcome<never>, { kind: 'ready' }> & WaitMetadata) | null {
  if (!record(value) || !failureKinds.includes(value.kind as (typeof failureKinds)[number])) return null;
  if (!exactKeys(value, ['kind'], ['retryAfter'])) return null;
  const wait = waitMetadata(value);
  return wait ? ({ kind: value.kind, ...wait } as Exclude<RatingOutcome<never>, { kind: 'ready' }> & WaitMetadata) : null;
}

function admitFigureOutcome(
  value: unknown,
  expected: { subject: string; question: string; population: string },
): (RatingOutcome<Figure> & WaitMetadata) | null {
  if (!record(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'idle')
    return exactKeys(value, ['kind']) ? ({ kind: 'idle' } as RatingOutcome<Figure>) : null;
  if (value.kind === 'ready') {
    if (!exactKeys(value, ['kind', 'value'])) return null;
    const admitted = admitRatingAggregate(
      { question: expected.question, subject: expected.subject, figures: [value.value] },
      { subject: expected.subject, question: expected.question, populations: [expected.population] },
    );
    return admitted ? { kind: 'ready', value: admitted.figures[0]! } : null;
  }
  return admitFailure(value) as (RatingOutcome<Figure> & WaitMetadata) | null;
}

function admitItem(
  value: unknown,
  expected: { subject: string; question: string; selected?: readonly string[] },
): PopulationItem | null {
  if (
    !record(value) ||
    !exactKeys(value, ['id', 'name', 'figure']) ||
    typeof value.id !== 'string' ||
    !uuid.test(value.id) ||
    value.id === GLOBAL ||
    typeof value.name !== 'string' ||
    [...value.name].length < 1 ||
    [...value.name].length > 1024
  )
    return null;
  const figure = admitFigureOutcome(value.figure, {
    subject: expected.subject,
    question: expected.question,
    population: value.id,
  });
  if (!figure || (expected.selected === undefined ? figure.kind !== 'idle' : figure.kind === 'idle')) return null;
  return { id: value.id, name: value.name, figure };
}

function admitPopulationResult(value: unknown, input: PopulationInput): PopulationEnvelope['result'] | null {
  if (!record(value) || typeof value.kind !== 'string') return null;
  if (value.kind !== 'ready') return admitFailure(value) as PopulationEnvelope['result'] | null;
  if (!exactKeys(value, ['kind', 'value']) || !record(value.value)) return null;

  const page = value.value;
  if (
    !exactKeys(page, ['items', 'next', 'incomplete']) ||
    !Array.isArray(page.items) ||
    page.items.length > 20 ||
    (page.next !== null && typeof page.next !== 'string') ||
    typeof page.incomplete !== 'boolean'
  )
    return null;

  const selected = input.selected;
  if (selected !== undefined && page.next !== null) return null;
  const requested = selected === undefined ? undefined : new Set(selected);
  const itemExpected = { subject: input.id, question: input.question, ...(selected === undefined ? {} : { selected }) };
  const seen = new Set<string>();
  const items: PopulationItem[] = [];
  for (const raw of page.items) {
    const item = admitItem(raw, itemExpected);
    if (!item || seen.has(item.id) || (requested && !requested.has(item.id))) return null;
    seen.add(item.id);
    items.push(item);
  }
  if (requested && (page.incomplete !== (seen.size < requested.size))) return null;
  return {
    kind: 'ready',
    value: { items, next: page.next, incomplete: page.incomplete },
  };
}

/** Validate every browser-consumed field before a transport result becomes query data. */
export function admitPopulationEnvelope(value: unknown, input: PopulationInput): PopulationEnvelope | null {
  try {
    if (!validRequest(input) || !record(value) || !exactKeys(value, ['reader', 'subject', 'question', 'result'], ['retryAfter']))
      return null;
    if (
      (value.reader !== null && (typeof value.reader !== 'string' || value.reader.length === 0)) ||
      value.reader !== input.expectedReader ||
      value.subject !== input.id ||
      value.question !== input.question
    )
      return null;
    const envelopeWait = waitMetadata(value);
    const result = admitPopulationResult(value.result, input);
    if (!envelopeWait || !result) return null;
    return {
      reader: value.reader,
      subject: value.subject,
      question: value.question,
      result,
      ...envelopeWait,
    } as PopulationEnvelope;
  } catch {
    return null;
  }
}
