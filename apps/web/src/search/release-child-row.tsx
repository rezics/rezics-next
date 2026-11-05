import { ResultRow, type ResultHit } from './results';
import type { ReleaseSearchCard } from './release-search-query';

/** Use the installed native result destination and catalogue date presentation. */
export function ReleaseResultRow({ card, locale }: { card: ReleaseSearchCard; locale: string }) {
  const { summary, kind: _kind, base, ...hit } = card;
  const result: ResultHit = { ...hit, ...(summary ? { summary } : {}) };
  const label = base.kindLabel;
  const types: Record<string, Record<string, string>> = {};
  if (
    label !== null &&
    typeof label === 'object' &&
    'value' in label &&
    typeof label.value === 'string' &&
    'language' in label &&
    typeof label.language === 'string'
  )
    types[card.type] = { [label.language]: label.value };
  return <ResultRow hit={result} locale={locale} hitTypes={types} yearProperties={['schema:datePublished']} />;
}
