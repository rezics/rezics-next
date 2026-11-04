import type { DiscoveryHit, DiscoveryState } from '../discovery';
import type { WorkContext, WorkContextStatement, WorkContextValue } from './schema';

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const term = (id: string, en: string) => ({ id, labels: { en } });
const item = (index: number, label: string, type = 'schema:Person'): WorkContextValue => ({
  state: 'value',
  kind: 'item',
  id: id(index),
  originalId: id(index),
  labels: { en: label },
  type: term(type, type === 'schema:Person' ? 'Person' : type),
});
function statement(
  index: number,
  source: number,
  property: string,
  label: string,
  value: WorkContextValue,
): WorkContextStatement {
  return {
    statementId: id(index),
    sourceId: id(source),
    direction: 'outgoing',
    property: term(property, label),
    revision: 2,
    release: `sha256:${'a'.repeat(64)}`,
    rank: 'normal',
    value,
    qualifiers: { state: 'empty' },
  };
}
const current = (entry: WorkContextStatement) => ({ state: 'current' as const, items: [entry], overflow: false });

/** Real released Type/property identities; illustrative supplied labels, never synthetic recording/release Types. */
export function qualifiedSearchHit(
  index: number,
  type: string,
  role: string,
  roleLabel: string,
  creator: string,
): DiscoveryHit {
  const credit = statement(index + 100, index, role, roleLabel, item(index + 200, creator));
  credit.qualifiers = {
    state: 'current',
    items: [
      {
        property: term('wdt:P1932', 'Credited as'),
        value: { state: 'value', kind: 'text', text: `${creator} (original credit)` },
      },
      { property: term('wdt:P3831', 'Role'), value: item(index + 500, 'Original edition translator', 'skos:Concept') },
    ],
  };
  const workContext: WorkContext = {
    state: 'current',
    subjectId: id(index),
    type: term(type, type),
    kind: type === 'bf:Instance' || type === 'wd:Q20631656' || type === 'rezics:AnimeRelease' ? 'release' : 'work',
    creators: current(credit),
    relations: { state: 'empty' },
    dates: current(
      statement(index + 300, index, 'schema:datePublished', 'Publication date', {
        state: 'value',
        kind: 'time',
        calendar: 'gregorian',
        year: 2000 + index,
        ...(index === 2 ? { month: 2 } : {}),
      }),
    ),
  };
  if (type === 'bf:Instance')
    workContext.relations = current(
      statement(index + 400, index, 'schema:exampleOfWork', 'Example of work', item(1, 'Echo', 'schema:Book')),
    );
  return {
    key: { owner: 'semantic', kind: type, route: 0, id: id(index) },
    summary: {
      kind: 'subject',
      value: {
        id: id(index),
        type,
        types: [type],
        label: { value: 'Echo', language: 'en' },
        creativeWork: true,
        cover: null,
      },
    },
    labels: { en: 'Echo' },
    aliases: { en: ['Echoes'] },
    descriptions: { en: 'Same title, independently admitted identity.' },
    facts: { [role]: [{ kind: 'item', id: id(index + 200), labels: { en: creator } }] },
    listPresentation: { imageAspect: type === 'schema:Movie' ? 'landscape' : 'portrait', keyFacts: [role] },
    workContext,
  };
}
export function qualifiedSearchExample(): Extract<DiscoveryState, { status: 'ready' }> {
  const hits = [
    qualifiedSearchHit(1, 'schema:Book', 'schema:author', 'Author', 'Mira Chen'),
    qualifiedSearchHit(2, 'schema:Book', 'schema:contributor', 'Contributor', 'Robin Lee'),
    qualifiedSearchHit(3, 'schema:MusicAlbum', 'schema:contributor', 'Contributor', 'Mira Chen'),
    qualifiedSearchHit(4, 'schema:Movie', 'schema:director', 'Director', 'Robin Lee'),
    qualifiedSearchHit(5, 'schema:VideoGame', 'schema:contributor', 'Contributor', 'North Studio'),
    qualifiedSearchHit(6, 'bf:Instance', 'schema:publisher', 'Publisher', 'North Press'),
  ];
  return {
    status: 'ready',
    page: {
      hits,
      kinds: {
        values: [...new Set(hits.map((hit) => hit.key.kind))].map((id) => ({ id, labels: { en: id }, icon: 'book' })),
        next: null,
      },
      next: 'native-next',
      as_of: '2026-11-04T00:00:00Z',
    },
  };
}
