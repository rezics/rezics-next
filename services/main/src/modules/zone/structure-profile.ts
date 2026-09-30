import { createHash } from 'node:crypto';
import { GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import type { OccurrenceRecord } from '../structure/format.ts';
import type { PlacementState } from '../structure/graph.ts';
import type { StructureProfileRegistration } from '../structure/profiles.ts';
import { CompositionConflict } from '../structure/change.ts';
import { ZONE_RESERVED_SEGMENTS } from './route-path.ts';

const PROFILE = 'https://rezics.com/definition/zone-capability-v1';

function qualifierId(placement: string): string {
  return `urn:rezics:zone-mount:${createHash('sha256').update(placement).digest('hex')}`;
}

function project(state: PlacementState, generation: string) {
  const mount = state.qualifier;
  if (mount?.type !== 'zone-mount') return null;
  const id = qualifierId(state.placement);
  const subject = iri(id);
  return { iri: id, triples: [
    `${subject} a rv:ZoneMount ; rv:generation ${iri(generation)} ; rv:zone ${iri(mount.zone)} ;`,
    `  rv:routeSegment ${lit(mount.routeSegment)} ; rv:disclosure rv:${mount.disclosure === 'public' ? 'Public' : 'Private'} .`,
    ...(mount.presentation ? [`${subject} rv:presentation ${iri(mount.presentation)} .`] : []),
  ] };
}

async function hydrate(env: WorkActivationEnvironment, state: PlacementState):
  Promise<OccurrenceRecord['qualifier'] | undefined> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?zone ?segment ?disclosure ?presentation WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(state.placement)} rv:qualifier ?q .
      ?q a rv:ZoneMount ; rv:zone ?zone ; rv:routeSegment ?segment ; rv:disclosure ?disclosure .
      OPTIONAL { ?q rv:presentation ?presentation } } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1) return undefined;
  const row = rows[0]!;
  if (!row.zone?.value || !row.segment?.value || !row.disclosure?.value) return undefined;
  return { type: 'zone-mount', zone: row.zone.value, routeSegment: row.segment.value,
    disclosure: row.disclosure.value === `${RV}Public` ? 'public' : 'private',
    ...(row.presentation?.value ? { presentation: row.presentation.value } : {}) };
}

async function validate(env: WorkActivationEnvironment, changed: readonly PlacementState[]) {
  const mounts = changed.filter(state => state.active && state.qualifier?.type === 'zone-mount');
  const segments = new Set<string>();
  for (const state of mounts) {
    const mount = state.qualifier!;
    if (mount.type !== 'zone-mount') continue;
    const key = `${mount.zone}\0${mount.routeSegment}`;
    if ((ZONE_RESERVED_SEGMENTS as readonly string[]).includes(mount.routeSegment) || segments.has(key)) {
      throw new CompositionConflict('Zone route segment is reserved or already mounted');
    }
    segments.add(key);
    // This read precedes the Structure head CAS. Any competing insertion moves
    // that head, so two editors cannot both commit the same segment.
    const conflict = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(mount.zone)} rv:navigation ?structure .
        ?structure rv:selectedGeneration ?generation .
        ?placement a rv:OccurrencePlacement ; rv:generation ?generation ;
          rv:occurrenceRole rv:MountRole ; rv:qualifier ?qualifier .
        ?qualifier a rv:ZoneMount ; rv:zone ${iri(mount.zone)} ; rv:routeSegment ${lit(mount.routeSegment)} .
        FILTER(?placement != ${iri(state.placement)})
        FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
      } }`, 1024);
    if (conflict.boolean === true) throw new CompositionConflict('Zone route segment is already mounted');
  }
  const focus = changed.filter(state => state.qualifier?.type === 'zone-mount')
    .map(state => qualifierId(state.placement));
  return focus.length ? profileValidations(env.fuseki, 'zone-capability-v1', [
    { shape: `${PROFILE}/mount-shape`, focus, graphs: [GRAPHS.current] },
  ]) : [];
}

/** Zone navigation belongs to the Zone capability, independent of its Space's Realm. */
export const structureProfiles: readonly StructureProfileRegistration[] = [{
  id: 'zone-navigation',
  graphProfile: `${RV}ZoneNavigation`,
  ownerType: `${RV}Zone`,
  componentType: `${RV}Zone`,
  structurePredicate: `${RV}navigation`,
  ownerValidation: { profile: 'zone-capability-v1',
    shape: 'https://rezics.com/definition/zone-capability-v1/navigation-link-shape' },
  editScopePrefix: 'zone:edit:',
  editPermission: 'zone:edit',
  targetReadPermission: 'semantic:read',
  authorizeTarget: async ({ environment, access, principal, actingSubject, target }) => {
    const work = environment && (await environment.fuseki.query(`PREFIX schema: <https://schema.org/> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(target)} a schema:CreativeWork } }`, 1024)).boolean === true;
    return work ? access.canReadWork(principal, actingSubject, target)
      : access.canReadSemanticResource?.(principal, actingSubject, target) ?? false;
  },
  editAction: 'zone.edit',
  receiptFamily: 'structure-command',
  roles: ['group', 'mount'],
  targetRoles: ['mount'],
  selectionRequiredRoles: [],
  projectQualifier: project,
  hydrateQualifier: hydrate,
  qualifierValidations: validate,
}];
