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
  NativeCopyListRow,
} from './types';

/** Named fail-closed seam until the installed Copy list declaration includes context. */
export function unavailableCopyListContext(): NativeCopyListContext {
  return { state: 'unavailable' };
}

/**
 * The installed KernelClient.copies.get row has no context field. Do not receive an undeclared payload;
 * the publisher must install that field before this seam can consume it directly.
 */
export function copyListContextFromNativeRow(_copy: NativeCopyListRow): NativeCopyListContext {
  return unavailableCopyListContext();
}

function selectedLabel(
  labels: Record<string, string>,
  locale: string,
): Pick<CopyReadingIdentity, 'label' | 'labelLanguage'> | undefined {
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
  const properties = Object.keys(facts)
    .filter((property) => property !== 'schema:exampleOfWork')
    .slice(0, 4);
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
