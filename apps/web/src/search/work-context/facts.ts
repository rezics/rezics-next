import { pickText } from '@rezics/composition';
import type { Fact } from '../results';
import { hitCalendarDate } from '../release-search-date';

/** Metadata already admitted by Search's definition read; this adapter performs no reads. */
export type ResultFactDefinitions = Readonly<Record<string, { labels?: Record<string, string> }>>;

export function resultFactLabel(property: string, definitions: ResultFactDefinitions | undefined, locale: string) {
  const labels = definitions && Object.hasOwn(definitions, property) ? definitions[property]?.labels : undefined;
  const picked = pickText(labels ?? {}, locale);
  // A property name never grows with a creator list or a catalogue label's length.
  const characters = Array.from(picked.text.slice(0, 194));
  return {
    text: characters.length > 96 ? `${characters.slice(0, 95).join('')}…` : picked.text,
    ...(picked.lang ? { lang: picked.lang } : {}),
  };
}

/** Keep the selected property's identity alongside its recorded date and precision. */
export function resultDateFact(
  facts: Readonly<Record<string, readonly Fact[]>> | undefined,
  properties: readonly string[],
) {
  for (const property of properties.slice(0, 4)) {
    const date = hitCalendarDate(facts, [property]);
    if (date) return { property, date };
  }
  return undefined;
}
