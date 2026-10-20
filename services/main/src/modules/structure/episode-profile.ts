import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { genericWorkType } from '../work/work-kinds.ts';
import { CompositionUnavailable } from './unavailable.ts';
import { checkOccurrenceQualifier, InvalidStructureObject, type OccurrenceRecord } from './format.ts';
import type { PlacementState } from './graph.ts';
import type { StructureProfileRegistration, StructureTargetAuthority } from './profiles.ts';
import { projectQualifierFields, type QualifierTemplate } from './qualifier-template.ts';

const EPISODE = 'https://schema.org/TVEpisode';
const template: QualifierTemplate = {
  id: 'episode-order-v1', form: 'fields', rdfType: 'EpisodeOrder',
  idPrefix: 'urn:rezics:episode-order:', onPlacement: true,
  fields: [
    { name: 'position', kind: 'rational', numerator: 'episodePositionNumerator', denominator: 'episodePositionDenominator' },
    { name: 'disc', kind: 'rational', numerator: 'episodeDiscNumerator', denominator: 'episodeDiscDenominator' },
    { name: 'kindCode', kind: 'text', predicate: 'episodeKindCode' },
    { name: 'kindScheme', kind: 'text', predicate: 'episodeKindScheme' },
    { name: 'label', kind: 'text', predicate: 'episodeOrderLabel' },
  ],
};
const fields = new Set(template.fields.map(field => field.name));
type FieldQualifier = Extract<NonNullable<OccurrenceRecord['qualifier']>, { type: 'fields' }>;

/** Source position is independent of sibling ordering and of the Episode's own
 * number. Codes keep their namespace; no code implies a native episode kind. */
export function checkEpisodeOrder(value: unknown): FieldQualifier {
  const qualifier = checkOccurrenceQualifier(value);
  if (qualifier.type !== 'fields' || qualifier.id !== template.id
    || Object.keys(qualifier.values).some(key => !fields.has(key)))
    throw new InvalidStructureObject('episode order differs from its declared fields');
  const rational = (name: string, required: boolean, integer = false) => {
    const value = qualifier.values[name];
    if (value === undefined && !required) return;
    if (!value || typeof value !== 'object' || !('numerator' in value) || !('denominator' in value)
      || integer && value.denominator !== 1)
      throw new InvalidStructureObject(`episode ${name} requires an exact ${integer ? 'integer' : 'rational'}`);
    let a = value.numerator, b = value.denominator;
    while (b) [a, b] = [b, a % b];
    if (a !== 1) throw new InvalidStructureObject(`episode ${name} requires a reduced rational`);
  };
  rational('position', true);
  rational('disc', false, true);
  for (const name of ['kindCode', 'kindScheme', 'label']) {
    const value = qualifier.values[name];
    if (value !== undefined && (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)))
      throw new InvalidStructureObject(`episode ${name} requires declared text`);
  }
  if ((qualifier.values.kindCode === undefined) !== (qualifier.values.kindScheme === undefined))
    throw new InvalidStructureObject('episode kind code requires its exact scheme');
  return qualifier;
}

/** The native target must remain an exact supporting Episode resource. A Work,
 * recording, release, occurrence or followed redirect cannot substitute for it. */
export async function authorizeEpisodeTarget(authority: StructureTargetAuthority): Promise<boolean> {
  if (!authority.targetReader) throw new CompositionUnavailable('Episode target reader is unavailable');
  if (!authority.access.canReadSemanticResource)
    throw new CompositionUnavailable('Episode Resource authority is unavailable');
  // Target summaries discover Structure profiles; load the command reader only
  // after that registration has finished.
  const { resolveCommandTarget } = await import('../target/resolve.ts');
  return authority.targetReader(async session => {
    const target = await resolveCommandTarget(session, authority.target);
    return target.resource === authority.target && target.base === 'resource' && target.types.includes(EPISODE)
      && await authority.access.canReadSemanticResource!(authority.principal, authority.actingSubject, authority.target);
  });
}

/** One bounded probe and the same predicate in the commit guard. Current native
 * grain and exact type are checked again when the owner command commits. */
export async function episodeTargetGuard(env: WorkActivationEnvironment, _owner: string, targets: readonly string[]) {
  if (!targets.length) return { guard: '', rejection: '' };
  const values = `VALUES ?target { ${[...new Set(targets)].map(iri).join(' ')} }`;
  const invalid = `${values} {
    { FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
      ?target a <${EPISODE}> ; rv:semanticHead ?episodeHead . } } }
    UNION { GRAPH ${iri(GRAPHS.current)} { ?target a ?otherGrain .
      VALUES ?otherGrain { <${genericWorkType}> rv:MainVersion rv:TextContribution
        rv:Realization rv:Release <https://schema.org/ListItem> rv:Projection rv:Post rv:ZoneHomeDocument } } }
    UNION { GRAPH ${iri(GRAPHS.revisions)} { ?target a rv:FixedRelease } }
  }`;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?target WHERE { ${invalid} } LIMIT 1`);
  return { guard: `FILTER NOT EXISTS { ${invalid} }`, rejection: `FILTER EXISTS { ${invalid} }`,
    invalid: Boolean(result.results?.bindings.length) };
}

export function projectEpisodeOrder(state: PlacementState, generation: string) {
  if (state.role !== 'episode' || !state.qualifier) return null;
  checkEpisodeOrder(state.qualifier);
  return projectQualifierFields(template, state, generation);
}

/** Exact, bounded recovery. A partial rational, repeated field or wrong literal
 * refuses the edit instead of silently discarding a nonempty owner field. */
export async function hydrateEpisodeOrder(env: WorkActivationEnvironment,
  state: PlacementState): Promise<OccurrenceRecord['qualifier'] | undefined> {
  if (state.role !== 'episode') return undefined;
  const predicates = template.fields.flatMap(field => field.kind === 'rational'
    ? [field.numerator, field.denominator] : 'predicate' in field ? [field.predicate] : []);
  const numericPredicates = new Set(template.fields.flatMap(field => field.kind === 'rational'
    ? [field.numerator, field.denominator] : []));
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?p ?o WHERE {
    VALUES ?p { ${predicates.map(predicate => `rv:${predicate}`).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ${iri(state.placement)} ?p ?o }
  } LIMIT ${predicates.length + 1}`, 32 * 1024);
  const rows = result.results?.bindings ?? [];
  if (rows.length > predicates.length) return undefined;
  const values = new Map<string, string>();
  for (const row of rows) {
    const key = row.p?.value.slice(RV.length), value = row.o;
    if (row.p?.type !== 'uri' || !row.p.value.startsWith(RV) || !key || !predicates.includes(key) || values.has(key)
      || !value || !['literal', 'typed-literal'].includes(value.type) || value['xml:lang']) return undefined;
    if (numericPredicates.has(key) ? value.datatype !== 'http://www.w3.org/2001/XMLSchema#integer'
      : value.datatype !== undefined && value.datatype !== 'http://www.w3.org/2001/XMLSchema#string') return undefined;
    values.set(key, value.value);
  }
  const built: FieldQualifier = { type: 'fields', id: template.id, values: {} };
  for (const field of template.fields) {
    if (field.kind === 'rational') {
      const numerator = values.get(field.numerator), denominator = values.get(field.denominator);
      if (numerator === undefined && denominator === undefined) continue;
      if (numerator === undefined || denominator === undefined
        || !/^(0|[1-9][0-9]*)$/.test(numerator) || !/^[1-9][0-9]*$/.test(denominator)) return undefined;
      built.values[field.name] = { numerator: Number(numerator), denominator: Number(denominator) };
    } else if (field.kind === 'text') {
      const value = values.get(field.predicate);
      if (value !== undefined) built.values[field.name] = value;
    }
  }
  try { return checkEpisodeOrder(built); }
  catch (error) { if (error instanceof InvalidStructureObject) return undefined; throw error; }
}

/** Work authority owns the list; the episode identity and Semantic authority stay
 * with its supporting-resource owner. This profile grants no Source adoption. */
export const episodeStructureProfile: StructureProfileRegistration = {
  id: 'episode-list-v1', graphProfile: `${RV}EpisodeList`,
  ownerType: genericWorkType, componentType: `${RV}MainVersion`, componentPredicate: `${RV}mainVersion`,
  editScopePrefix: 'work:edit:', editPermission: 'work:edit', editAction: 'work.edit',
  receiptFamily: 'edit-metadata-work', targetReadPermission: 'work:read', targetDisclosure: 'structure-target',
  authorizeTarget: authorizeEpisodeTarget, targetGuard: episodeTargetGuard, withholdUnreadableTargets: true,
  roles: ['group', 'episode'], containerRoles: ['group'], targetRoles: ['episode'], readingRoles: ['episode'],
  selectionRequiredRoles: [], maxDepth: 2,
  qualifiers: { episode: { type: 'fields', required: true, fieldId: template.id } },
  checkOccurrence(record) {
    if (record.role !== 'episode') return;
    if (record.selection) throw new InvalidStructureObject('an Episode resource carries no Content selection');
    checkEpisodeOrder(record.qualifier);
  },
  projectQualifier: projectEpisodeOrder, hydrateQualifier: hydrateEpisodeOrder,
};
