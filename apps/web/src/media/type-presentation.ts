import { parseListPresentation, type ListPresentation } from '@rezics/ui/cover';
import { pickText } from '@rezics/composition';
import type { Fact } from '../search/results';
import { releaseDateText } from '../search/release-search-date';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Adapts the agreed optional release annotation when present. This narrow input boundary does not imply that the
 * current definitions API publishes the annotation. The compiler supplies effective whole objects and property
 * lists; this adapter only reads those objects, never reconstructs inheritance from candidate source definitions.
 */
export function releasedListPresentation(
  types: readonly string[],
  releaseTypes: unknown,
): ListPresentation | undefined {
  if (!isRecord(releaseTypes)) return undefined;

  for (const type of types) {
    if (!Object.hasOwn(releaseTypes, type)) continue;
    const definition = releaseTypes[type];
    if (!isRecord(definition)) continue;

    const presentation = Object.hasOwn(definition, 'listPresentation')
      ? parseListPresentation(definition.listPresentation)
      : undefined;
    const properties = definition.properties;
    if (
      presentation &&
      Array.isArray(properties) &&
      presentation.keyFacts.every((property) => properties.includes(property))
    )
      return presentation;
  }
  return undefined;
}

export type PresentedFact = { property: string; text: string; lang?: string };

/** Format only the existing supplied Fact projection: four properties, three values each, four visible values. */
export function listKeyFacts(
  facts: Readonly<Record<string, readonly Fact[]>> | undefined,
  properties: readonly string[] | undefined,
  yearProperties: readonly string[],
  locale: string,
): PresentedFact[] {
  const visible: PresentedFact[] = [];
  for (const property of (properties ?? Object.keys(facts ?? {})).slice(0, 4)) {
    if (yearProperties.includes(property) || !facts || !Object.hasOwn(facts, property)) continue;
    for (const value of facts[property]?.slice(0, 3) ?? []) {
      let formatted: { text: string; lang?: string } | undefined;
      if (value.kind === 'item') {
        const label = pickText(value.labels, locale);
        formatted = { text: label.text, ...(label.lang ? { lang: label.lang } : {}) };
      } else if (value.kind === 'time') {
        const text = releaseDateText(value, locale);
        if (text) formatted = { text };
      } else if (value.kind === 'quantity' && Number.isFinite(value.amount)) {
        formatted = {
          text: `${new Intl.NumberFormat(locale).format(value.amount)}${value.unit ? ` ${value.unit}` : ''}`,
        };
      } else if (value.kind === 'code') formatted = { text: value.value };
      if (!formatted?.text) continue;
      visible.push({ property, ...formatted });
      if (visible.length === 4) return visible;
    }
  }
  return visible;
}
