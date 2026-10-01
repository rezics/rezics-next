import { direction } from '@rezics/main/language';
import type { StatementGroup } from '../entity-page/types.ts';
import { iri, summary } from '../work-levels/fixtures.ts';
import type { Loaded, RelationEntry, RelationsPage, Summary } from '../work-levels/types.ts';
import { WIKI_ZONE_PREDICATE } from './wiki.ts';

// Story and test fixtures for the hub's wiki section, in the shapes Main answers.

export const wikiRealm = '01944100-0000-7000-8000-0000000000e1';

/** The statement group a franchise Work carries to name its wiki Zone (G-849's starter writes it). */
export const wikiStatements = (realm: string = wikiRealm): StatementGroup[] => [{ predicate: WIKI_ZONE_PREDICATE,
  items: [{ kind: 'statement', predicate: WIKI_ZONE_PREDICATE, revision: iri('e2'),
    value: { kind: 'resource', iri: `https://rezics.com/id/${realm}` } }] }] as unknown as StatementGroup[];

export const character = (name: string, tail: string): Summary => ({ ...summary(iri(tail), name, 'en', 'resource'),
  type: 'character' }) as unknown as Summary;

/** The Work's relations at the reader's position: the characters Main revealed up to it, and nothing after. */
export function characterRelations(characters: readonly Summary[]): Loaded<RelationsPage> {
  const entry = { relation: iri('f1'), kind: 'occurrence', revision: iri('f2'), evidence: null, counterparts: characters,
    rendering: { profile: 'relation-rendering-v1', meaning: { definition: iri('f3'), revision: iri('f4') }, viewingRole: 'work',
      projections: [{ fromRole: 'work', toRole: 'character', language: 'en', direction: direction('en'), fallback: null,
        labels: { noun: 'Character', heading: 'Characters', plurals: { one: 'Character', other: 'Characters' } },
        arguments: characters.map(item => ({ role: 'character', type: 'resource',
          value: { kind: 'resource', ref: item.reference } })) }] } } as unknown as RelationEntry;
  return { ok: true, data: { profile: 'resource-relations-v1', resource: iri('100'),
    items: characters.length ? [entry] : [], next: null,
    sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' } } };
}
