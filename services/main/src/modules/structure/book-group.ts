import { createHash } from 'node:crypto';
import { profileValidations } from '../../infrastructure/profile.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { BOOK_DIVISIONS, type BookDivision, type OccurrenceRecord } from './format.ts';
import type { PlacementState } from './graph.ts';

// A Book group's division rides on its placement as a qualifier node, as a Zone
// mount does: the shared placement shape stays unchanged and the Book profile
// validates its own node.

const PROFILE = 'https://rezics.com/definition/structure-book-v1';
const DIVISION_IRI: Record<BookDivision, string> = {
  volume: `${RV}VolumeDivision`, part: `${RV}PartDivision`, extras: `${RV}ExtrasDivision`,
};

export function bookGroupQualifierId(placement: string): string {
  return `urn:rezics:book-group:${createHash('sha256').update(placement).digest('hex')}`;
}

export function divisionOf(iriValue: string | undefined): BookDivision | null {
  return BOOK_DIVISIONS.find(division => DIVISION_IRI[division] === iriValue) ?? null;
}

export function divisionIri(division: BookDivision): string { return DIVISION_IRI[division]; }

export function projectBookGroup(state: PlacementState, generation: string) {
  if (state.qualifier?.type !== 'book-group') return null;
  const id = bookGroupQualifierId(state.placement);
  return { iri: id, triples: [`${iri(id)} a rv:BookGroup ; rv:generation ${iri(generation)} ;
    rv:bookDivision <${DIVISION_IRI[state.qualifier.division]}> .`] };
}

export async function hydrateBookGroup(env: WorkActivationEnvironment, state: PlacementState):
  Promise<OccurrenceRecord['qualifier'] | undefined> {
  if (state.role !== 'group') return undefined;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?division WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(state.placement)} rv:qualifier ?q .
      ?q a rv:BookGroup ; rv:bookDivision ?division . } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  const division = rows.length === 1 ? divisionOf(rows[0]?.division?.value) : null;
  return division ? { type: 'book-group', division } : undefined;
}

export async function validateBookGroups(env: WorkActivationEnvironment, changed: readonly PlacementState[]) {
  const focus = changed.filter(state => (state.active || state.tombstone) && state.qualifier?.type === 'book-group')
    .map(state => bookGroupQualifierId(state.placement));
  return focus.length ? profileValidations(env.fuseki, 'structure-book-v1', [
    { shape: `${PROFILE}/group-shape`, focus, graphs: [GRAPHS.current] },
  ]) : [];
}
