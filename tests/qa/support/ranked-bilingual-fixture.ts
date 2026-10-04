import { fixtureUuid, publicUnitAt, type Corpus } from '../../../scripts/fixture/corpus.ts';
import { GRAPHS, ID, RV } from '../../../services/main/src/modules/work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';

export const RANKED_BILINGUAL_MAINS = 100;

/** Background search witnesses, loaded offline with the base corpus. They carry
 * no interactive receipts; the traversal still performs one real selection
 * write afterwards to prove that its saved cursor is fenced. */
export function rankedBilingualQuads(
  corpus: Corpus,
): { graph: 'current' | 'revisions' | 'public'; quad: string }[] {
  const quads: ReturnType<typeof rankedBilingualQuads> = [];
  for (let index = 0; index < RANKED_BILINGUAL_MAINS; index++) {
    const ordinal = 1025 + index,
      source = publicUnitAt(corpus, ordinal);
    const id = (kind: string) => ID + fixtureUuid(corpus.seed, `ranked-fr-${kind}:${ordinal}`);
    const contribution = id('contribution'),
      draft = id('draft'),
      decision = id('decision'),
      selection = id('selection'),
      unit = id('unit');
    const add = (
      graph: 'current' | 'revisions' | 'public',
      subject: string,
      predicate: string,
      object: string,
    ) => {
      const target = graph === 'public' ? PUBLIC_SEARCH_GRAPH : GRAPHS[graph];
      quads.push({ graph, quad: `<${subject}> <${predicate}> ${object} <${target}> .\n` });
    };
    const resource = (
      graph: 'current' | 'revisions' | 'public',
      subject: string,
      predicate: string,
      value: string,
    ) => add(graph, subject, RV + predicate, `<${value}>`);
    const type = (graph: 'current' | 'revisions' | 'public', subject: string, value: string) =>
      add(graph, subject, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `<${RV}${value}>`);
    resource('current', source.work.mainVersion, 'selectionHead', selection);
    type('current', contribution, 'TextContribution');
    resource('current', contribution, 'work', source.work.work);
    resource('current', contribution, 'author', source.work.agent);
    resource('current', contribution, 'draftHead', draft);
    resource('current', contribution, 'publicationHead', decision);
    add('current', contribution, RV + 'language', '"fr"');
    type('revisions', draft, 'RevisionAnchor');
    resource('revisions', draft, 'component', contribution);
    type('revisions', decision, 'PublicationDecision');
    resource('revisions', decision, 'component', contribution);
    resource('revisions', decision, 'work', source.work.work);
    resource('revisions', decision, 'contribution', contribution);
    resource('revisions', decision, 'selectedDraft', draft);
    resource('revisions', decision, 'disclosure', RV + 'Public');
    add('revisions', decision, RV + 'language', '"fr"');
    type('revisions', selection, 'PublicationSelection');
    for (const [predicate, value] of Object.entries({
      work: source.work.work,
      mainVersion: source.work.mainVersion,
      context: source.work.mainVersion,
      contribution,
      publicationDecision: decision,
      selectedDraft: draft,
      matchUnit: unit,
      selectionBasis: RV + 'MainMaintainer',
      selectionMode: RV + 'Fixed',
    }))
      resource('revisions', selection, predicate, value);
    add('revisions', selection, RV + 'language', '"fr"');
    type('public', unit, 'MatchUnit');
    for (const [predicate, value] of Object.entries({
      work: source.work.work,
      mainVersion: source.work.mainVersion,
      context: source.work.mainVersion,
      contribution,
      revision: draft,
      selection,
      field: RV + 'Body',
      disclosure: RV + 'Public',
    }))
      resource('public', unit, predicate, value);
    add('public', unit, RV + 'language', '"fr"');
    add('public', unit, RV + 'searchBody', '"fixture body"@fr');
    add('public', unit, RV + 'publicTitle', `${JSON.stringify(source.work.title)}@en`);
  }
  return quads;
}
