import { isCalendarDate } from '@rezics/filter';
import type { Release } from '../../subject/definitions';
import { listKeyFacts } from '../../media/type-presentation';
import type { Fact } from '../../search/results';
import { relationDefinitions } from '../../subject/relations';
import { copiesSubjectId } from '../copies-query';
import type {
  CopyReadingContext,
  CopyReadingFact,
  CopyReadingIdentity,
  NativeCopyContextIdentity,
  NativeCopyListContext,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function stringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function factOf(value: unknown): Fact | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return;
  if (value.kind === 'item') {
    if (
      !onlyKeys(value, ['kind', 'id', 'labels']) ||
      typeof value.id !== 'string' ||
      !stringMap(value.labels)
    )
      return;
    return { kind: 'item', id: value.id, labels: value.labels };
  }
  if (value.kind === 'time') {
    if (!onlyKeys(value, ['kind', 'year', 'month', 'day']) || !isCalendarDate(value)) return;
    return {
      kind: 'time',
      year: value.year,
      ...(value.month === undefined ? {} : { month: value.month }),
      ...(value.day === undefined ? {} : { day: value.day }),
    };
  }
  if (value.kind === 'quantity') {
    if (!onlyKeys(value, ['kind', 'amount', 'unit']) || typeof value.amount !== 'number' || !Number.isFinite(value.amount))
      return;
    if (typeof value.unit !== 'string') return;
    return { kind: 'quantity', amount: value.amount, unit: value.unit };
  }
  if (value.kind === 'code') {
    if (!onlyKeys(value, ['kind', 'value']) || typeof value.value !== 'string') return;
    return { kind: 'code', value: value.value };
  }
}

function identityOf(value: unknown): NativeCopyContextIdentity | undefined {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['id', 'labels']) ||
    typeof value.id !== 'string' ||
    !stringMap(value.labels)
  )
    return;
  return { id: value.id, labels: value.labels };
}

function factsOf(value: unknown): Record<string, Fact[]> | undefined {
  if (!isRecord(value) || Object.keys(value).length > 4) return;
  const facts: Record<string, Fact[]> = Object.create(null);
  for (const [property, items] of Object.entries(value)) {
    if (!property || !Array.isArray(items) || items.length > 3) return;
    const parsed: Fact[] = [];
    for (const item of items) {
      const fact = factOf(item);
      if (!fact) return;
      parsed.push(fact);
    }
    facts[property] = parsed;
  }
  return facts;
}

/** Named fail-closed seam while Commerce prepares the generated copies declaration. */
export function unavailableCopyListContext(): NativeCopyListContext {
  return { state: 'unavailable' };
}

function parseCopyListContext(value: unknown): NativeCopyListContext {
  if (!isRecord(value) || typeof value.state !== 'string') return unavailableCopyListContext();
  if (value.state === 'available') {
    if (!onlyKeys(value, ['state', 'work', 'facts']) || !Array.isArray(value.work) || value.work.length > 3)
      return unavailableCopyListContext();
    const work: NativeCopyContextIdentity[] = [];
    for (const item of value.work) {
      const identity = identityOf(item);
      if (!identity) return unavailableCopyListContext();
      work.push(identity);
    }
    const facts = factsOf(value.facts);
    return facts ? { state: 'available', work, facts } : unavailableCopyListContext();
  }
  if (value.state === 'unsupported') {
    if (!onlyKeys(value, ['state', 'facts'])) return unavailableCopyListContext();
    const facts = factsOf(value.facts);
    return facts ? { state: 'unsupported', facts } : unavailableCopyListContext();
  }
  if (
    (value.state === 'scope' || value.state === 'withheld' || value.state === 'missing' || value.state === 'unavailable') &&
    onlyKeys(value, ['state'])
  )
    return { state: value.state };
  return unavailableCopyListContext();
}

/**
 * Reads the optional producer field from a FULL copy row without asserting a local wire type. The installed client
 * declaration currently omits it; malformed or absent values become the named unavailable context.
 */
export function copyListContextFromNativeRow(copy: object): NativeCopyListContext {
  const context: unknown = Object.hasOwn(copy, 'context') ? Reflect.get(copy, 'context') : undefined;
  return parseCopyListContext(context);
}

function selectedLabel(labels: Record<string, string>, locale: string): Pick<CopyReadingIdentity, 'label' | 'labelLanguage'> | undefined {
  const baseLanguage = locale.split('-')[0];
  const language = [locale, ...(baseLanguage ? [baseLanguage] : []), 'en'].find((candidate) => !!labels[candidate]);
  if (!language) return;
  const label = labels[language];
  return label ? { label, labelLanguage: language } : undefined;
}

function workIdentity(value: NativeCopyContextIdentity, locale: string): CopyReadingIdentity | undefined {
  const id = copiesSubjectId(value.id);
  const label = selectedLabel(value.labels, locale);
  return id && label ? { id, ...label } : undefined;
}

function propertyLabels(release: Pick<Release, 'properties'>, properties: Iterable<string>, locale: string) {
  const labels: Record<string, string> = Object.create(null);
  for (const [property, definition] of Object.entries(relationDefinitions(release, properties, locale)))
    if (definition.label) labels[property] = definition.label;
  return labels;
}

function presentedFacts(
  facts: Record<string, Fact[]>,
  release: Pick<Release, 'properties'>,
  locale: string,
): CopyReadingFact[] {
  const properties = Object.keys(facts).filter((property) => property !== 'schema:exampleOfWork').slice(0, 4);
  const labels = propertyLabels(release, properties, locale);
  const visible: CopyReadingFact[] = [];
  for (const property of properties) {
    for (const value of facts[property] ?? []) {
      const formatted = listKeyFacts({ [property]: [value] }, [property], [], locale)[0];
      if (!formatted) continue;
      const id = value.kind === 'item' ? copiesSubjectId(value.id) : undefined;
      const subject = id
        ? { id, label: formatted.text, ...(formatted.lang ? { labelLanguage: formatted.lang } : {}) }
        : undefined;
      visible.push({
        property,
        label: labels[property] ?? property,
        text: formatted.text,
        ...(formatted.lang ? { language: formatted.lang } : {}),
        ...(subject ? { subject } : {}),
      });
      if (visible.length === 4) return visible;
    }
  }
  return visible;
}

/** Format only native selected facts and identities; the release digest is never treated as an edition. */
export function presentCopyListContext(
  context: NativeCopyListContext,
  release: Pick<Release, 'properties'>,
  locale: string,
): CopyReadingContext {
  if (context.state === 'available')
    return {
      state: 'available',
      work: context.work.flatMap((identity) => {
        const selected = workIdentity(identity, locale);
        return selected ? [selected] : [];
      }),
      facts: presentedFacts(context.facts, release, locale),
    };
  if (context.state === 'unsupported')
    return { state: 'unsupported', facts: presentedFacts(context.facts, release, locale) };
  return { state: context.state };
}
