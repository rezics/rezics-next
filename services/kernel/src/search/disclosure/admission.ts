import { chooseLabel } from '@rezics/definitions';
import type { DiscoveryFilterDocument, ConceptSelection, FilterQualifier, FilterRange } from '@rezics/filter';
import type { IndexedSubject } from '../source.ts';

/** Native analyzer names are vocabulary, independent of the physical adapter. */
export const CJK_ANALYZER = 'cjk_bigram_v2';
export const NAME_PREFIX_ANALYZER = 'name_prefix';
export type EngineToken = Readonly<{
  token: string;
  position: number;
  startOffset: number;
  endOffset: number;
}>;

/** One OpenSearch hit, including the indexed partition, security revision and matched query names. */
export type Hit = { id: string; partition: number; securityRevision: number; matched: readonly string[] };

/** A filter leaf compiled by the route, keyed by its query name. */
export type FactClause =
  | { facet: 'type'; values: readonly string[] }
  | {
      facet: 'statement';
      property: string;
      qualifiers?: readonly FilterQualifier[];
      values: readonly string[];
      concept?: ConceptSelection;
      inverse?: true;
    }
  | { facet: 'statement'; property: string; qualifiers?: readonly FilterQualifier[]; range: FilterRange };

/** Texts by language, choosing one through the reader's chain when given. */
export function chooseTexts(
  list: IndexedSubject['labels'],
  languages: readonly string[] | undefined,
  original: string | undefined,
  map: (value: string) => string = (value) => value,
) {
  if (languages) {
    const chosen = chooseLabel(
      Object.fromEntries(list.map(({ language, value }) => [language, value])),
      languages,
      original,
    );
    return chosen ? { [chosen.language]: map(chosen.value) } : {};
  }
  return Object.fromEntries(list.map(({ language, value }) => [language, map(value)]));
}

type SelectedConcept = Readonly<{ property: string; concept: string; scheme: string }>;

export function conceptSelectionIdentity(selection: SelectedConcept): string {
  return JSON.stringify([selection.property, selection.concept, selection.scheme]);
}

export function conceptSelections(filter: DiscoveryFilterDocument): SelectedConcept[] {
  const result = new Map<string, SelectedConcept>();
  const pending: DiscoveryFilterDocument[] = [filter];
  while (pending.length) {
    const node = pending.pop()!;
    if ('and' in node || 'or' in node) pending.push(...('and' in node ? node.and : node.or));
    else if ('not' in node) pending.push(node.not);
    else if ('statement' in node && 'in' in node.statement && node.statement.concept) {
      const selection = {
        property: node.statement.property,
        concept: node.statement.in[0]!,
        scheme: node.statement.concept.scheme,
      };
      result.set(conceptSelectionIdentity(selection), selection);
    }
  }
  return [...result.values()];
}
