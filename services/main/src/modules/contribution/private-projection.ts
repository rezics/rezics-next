import { hash, iri, lit, RV } from '../work/activate.ts';

export const PRIVATE_SEARCH_GRAPH = 'urn:rezics:search:private';

/** A draft body has one private field unit; a new head has a new subject. */
export function privateDraftUnit(revision: string): string {
  iri(revision);
  return `urn:rezics:contribution:private-unit:${hash(revision)}`;
}

export function privateDraftTriples(contribution: string, revision: string,
  work: string, language: string, body: string): string {
  return `${iri(privateDraftUnit(revision))} a <${RV}MatchUnit> ;
    <${RV}contribution> ${iri(contribution)} ; <${RV}work> ${iri(work)} ;
    <${RV}revision> ${iri(revision)} ; <${RV}field> <${RV}Body> ;
    <${RV}disclosure> <${RV}Private> ; <${RV}language> ${lit(language)} ;
    <${RV}privateSearchBody> ${lit(body)}@${language} .`;
}
