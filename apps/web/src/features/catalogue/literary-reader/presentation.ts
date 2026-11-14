import type { LiteraryWindowKind } from './model';

export type LiteraryView = 'overview' | 'contents' | 'editions';

export function literaryView(view: string): LiteraryView {
  return view === 'contents' || view === 'editions' ? view : 'overview';
}

/** Stream selection is local to a family; Overview never retains projected list rows. */
export function literaryVisibleFamily(view: LiteraryView): LiteraryWindowKind | undefined {
  return view === 'contents' ? 'members' : view === 'editions' ? 'editions' : undefined;
}

export const literaryEssentialFields = [
  'schema:author',
  'schema:illustrator',
  'schema:translator',
  'schema:publisher',
  'schema:inLanguage',
  'schema:datePublished',
  'schema:startDate',
  'schema:endDate',
  'wdt:P7937',
  'schema:keywords',
  'schema:wordCount',
  'wdt:P2635',
  'schema:isbn',
  'schema:numberOfPages',
  'schema:exampleOfWork',
] as const;

export const literaryMembershipFields = ['wdt:P179', 'schema:isPartOf'] as const;

export function literaryFields(view: LiteraryView): readonly string[] {
  if (view === 'contents') return literaryMembershipFields;
  if (view === 'editions') return ['schema:exampleOfWork'];
  return literaryEssentialFields;
}
