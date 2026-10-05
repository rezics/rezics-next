import type { UiLocale } from '../../i18n/define.ts';
import { reader, settle } from '../work-page/read.ts';
import type { StatementPage } from './types.ts';

export interface PredicateLabel { value: string; language: string; direction: 'ltr' | 'rtl' }
export type PredicateLabels = ReadonlyMap<string, PredicateLabel>;

/** Labels are the definition's selected presentation, never an IRI fragment.
 * Unlabelled owner metadata retains its values without inventing a label. */
export async function readPredicateLabels(page: StatementPage, locale: UiLocale): Promise<PredicateLabels> {
  const definitions = [...new Set(page.groups.map(group => group.predicate))]
    .filter(predicate => /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(predicate));
  const labels = new Map<string, PredicateLabel>();
  if (!definitions.length) return labels;
  const { main, actingSubject } = await reader();
  for (let start = 0; start < definitions.length; start += 64) {
    const batch = definitions.slice(start, start + 64);
    const result = await settle(() => main.v1.lexicon.presentations.get({ query: {
      definitions: batch.join(','), languages: locale, actingSubject,
    } }));
    if (!result.ok) continue;
    for (const item of result.data.items) {
      const projections = item.renderings.flatMap(rendering => rendering.projections);
      const projection = projections.find(projection => projection.fromRole === 'subject' && projection.labels)
        ?? projections.find(projection => projection.labels);
      if (projection?.labels && projection.language && projection.direction)
        labels.set(item.definition, { value: projection.labels.noun,
          language: projection.language, direction: projection.direction });
    }
  }
  return labels;
}
