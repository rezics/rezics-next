import { createHash } from 'node:crypto';
import { profileValidations } from '../../infrastructure/profile.ts';
import { GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import type { PlacementState } from '../structure/graph.ts';
import type { StructureProfileRegistration } from '../structure/profiles.ts';
import type { OccurrenceRecord } from '../structure/format.ts';

const PROFILE = 'https://rezics.com/definition/structure-work-composition-v1';
const inclusions = { required: `${RV}RequiredPart`, optional: `${RV}OptionalPart`, extra: `${RV}ExtraPart` } as const;
const qualifierId = (placement: string) => `urn:rezics:work-part:${createHash('sha256').update(placement).digest('hex')}`;

export function projectWorkPart(state: PlacementState, generation: string) {
  if (state.qualifier?.type !== 'work-part') return null;
  const id = qualifierId(state.placement);
  return { iri: id, triples: [`${iri(id)} a rv:WorkPart ; rv:generation ${iri(generation)} ;
    rv:displayLabel ${lit(state.qualifier.displayLabel)} ;
    rv:partInclusion <${inclusions[state.qualifier.inclusion]}> .`,
    ...(state.active && state.target ? [`${iri(state.placement)} rv:composedWork ${iri(state.target)} .`] : [])] };
}

export async function hydrateWorkPart(env: WorkActivationEnvironment, state: PlacementState):
  Promise<OccurrenceRecord['qualifier'] | undefined> {
  if (state.role !== 'part') return undefined;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?label ?inclusion WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(state.placement)} rv:qualifier ?q .
      ?q a rv:WorkPart ; rv:displayLabel ?label ; rv:partInclusion ?inclusion . } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  const inclusion = Object.entries(inclusions).find(([, value]) => value === rows[0]?.inclusion?.value)?.[0];
  if (rows.length !== 1 || !inclusion || !rows[0]?.label?.value) return undefined;
  return { type: 'work-part', displayLabel: rows[0].label.value,
    inclusion: inclusion as keyof typeof inclusions };
}

// One edge follows only the selected generation. Retired, staging, removed and Book
// chapter placements never establish Work-level ancestry. No schema:isPartOf is written.
const edge = 'rv:mainVersion/^rv:structureOf/rv:selectedGeneration/^rv:generation/rv:composedWork';

/** Four Work levels bound the admission query and its transactional recheck.
 * SPARQL fixed sequences/alternatives (https://www.w3.org/TR/sparql11-query/#propertypaths)
 * keep this independent of any arbitrary-length closure. A fifth edge is refused.
 * One query, at most 16 targets for an edit or 4096 for a restore; one returned row.
 */
export function invalidWorkTargets(owner: string, targets: readonly string[]): string {
  const paths = Array.from({ length: 4 }, (_, index) => Array(index + 1).fill(edge).join('/'));
  const branches = [
    `FILTER(?target = ${iri(owner)})`,
    `FILTER NOT EXISTS { ?target a <https://schema.org/CreativeWork> ; rv:mainVersion ?targetMain . ?targetMain a rv:MainVersion }`,
    `?target (${paths.join('|')}) ${iri(owner)} .`,
    ...Array.from({ length: 5 }, (_, ancestors) => {
      const descendants = 4 - ancestors;
      return [ancestors ? `?ancestor ${Array(ancestors).fill(edge).join('/')} ${iri(owner)} .` : '',
        descendants ? `?target ${Array(descendants).fill(edge).join('/')} ?descendant .` : ''].join('\n');
    }),
  ];
  const values = `VALUES ?target { ${targets.map(iri).join(' ')} }`;
  return `GRAPH ${iri(GRAPHS.current)} { ${branches.map(branch => `{ ${values} ${branch} }`).join(' UNION ')} }`;
}

export async function workTargetGuard(env: WorkActivationEnvironment, owner: string,
  targets: readonly string[]) {
  if (!targets.length) return { guard: '', rejection: '' };
  const invalid = invalidWorkTargets(owner, targets);
  const prefixes = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>`;
  const result = await env.fuseki.query(`${prefixes} SELECT ?target WHERE { ${invalid} } LIMIT 1`);
  return { guard: `FILTER NOT EXISTS { ${invalid} }`, rejection: `FILTER EXISTS { ${invalid} }`,
    invalid: Boolean(result.results?.bindings.length) };
}

export const structureProfiles: readonly StructureProfileRegistration[] = [{
  id: 'work-composition', graphProfile: `${RV}WorkComposition`,
  ownerType: 'https://schema.org/CreativeWork', componentType: `${RV}MainVersion`,
  componentPredicate: `${RV}mainVersion`, editScopePrefix: 'work:edit:',
  editPermission: 'work:edit', editAction: 'work.edit', receiptFamily: 'edit-metadata-work',
  targetReadPermission: 'work:read',
  authorizeTarget: ({ access, principal, actingSubject, target }) => access.canReadWork(principal, actingSubject, target),
  targetGuard: workTargetGuard, withholdUnreadableTargets: true,
  roles: ['group', 'part'], targetRoles: ['part'], selectionRequiredRoles: [],
  topologyValidationProfile: 'structure-work-composition-v1',
  projectQualifier: projectWorkPart, hydrateQualifier: hydrateWorkPart,
  qualifierValidations: async (env, changed) => {
    const focus = changed.filter(state => (state.active || state.tombstone) && state.qualifier?.type === 'work-part')
      .map(state => qualifierId(state.placement));
    return focus.length ? profileValidations(env.fuseki, 'structure-work-composition-v1', [
      { shape: `${PROFILE}/part-shape`, focus, graphs: [GRAPHS.current] },
    ]) : [];
  },
}];
