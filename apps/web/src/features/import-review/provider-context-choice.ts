import { pickText } from '@rezics/composition';
import type { ContextChoices, ContextChoiceFailure, ContextChoiceRead } from '../contexts/choice-native';
import { globalReviewContext } from './provider-queue';

export type ProviderContextChoice = { id: string; label: string };
export type ProviderContextSource = {
  search(input: { query: string; cursor?: string }): Promise<ContextChoices | ContextChoiceFailure>;
  resolve(id: string): Promise<ContextChoiceRead>;
};
export const unavailableProviderContexts: ProviderContextSource = {
  search: async () => ({ kind: 'unavailable' }),
  resolve: async () => ({ kind: 'unavailable' }),
};
export function providerContextLabel(
  result: Extract<ContextChoiceRead, { context: unknown }>,
  locale: string,
  global: string,
) {
  return {
    id: result.context.id,
    label: result.context.id === globalReviewContext ? global : pickText(result.context.labels, locale).text,
  };
}
/** Canonical launch registrations from the importer contract; arbitrary valid configured aliases remain exact keys. */
export function providerSourceLabel(source: string): string {
  return (
    (
      { bangumi: 'Bangumi', vndb: 'VNDB', 'open-library': 'Open Library', wikidata: 'Wikidata' } as Record<
        string,
        string
      >
    )[source] ?? source
  );
}
