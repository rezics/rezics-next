import { join, resolve } from 'node:path';
import { RV } from '../work/activate.ts';
import { PROFILE_ROLES, type OccurrenceRole, type StructureProfile } from './format.ts';
import type { OccurrenceRecord } from './format.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import type { PlacementState } from './graph.ts';
import type { CommandValidation } from '../../infrastructure/fuseki.ts';

/** The shared Structure graph and object format; owners declare only their profile-specific policy. */
export interface StructureProfileRegistration {
  id: StructureProfile;
  /** Value of rv:structureProfile in the current graph. */
  graphProfile: string;
  /** Type of the resource that owns and authorizes this Structure. */
  ownerType: string;
  /** Type of the resource named by rv:structureOf. */
  componentType: string;
  /** Owner-to-component relation. Omit when the owner is the component. */
  componentPredicate?: string;
  /** Optional owner-to-Structure relation, such as rv:structure or rv:navigation. */
  structurePredicate?: string;
  /** Account OAuth scope needed for owner edits. */
  editPermission: string;
  /** Access action and graph receipt family for owner edits. */
  editAction: string;
  receiptFamily: string;
  /** Access scope on the authority resource. */
  editScopePrefix: string;
  /** Declared external catalog terms accepted as non-content occurrence targets. */
  catalogTargetTypes?: readonly string[];
  roles: readonly OccurrenceRole[];
  /** These roles may omit a target; all other non-target roles forbid it. */
  optionalTargetRoles?: readonly OccurrenceRole[];
  targetRoles: readonly OccurrenceRole[];
  /** Target roles selecting Content require an explicit/follow-context revision policy. */
  selectionRequiredRoles?: readonly OccurrenceRole[];
  /** An owner projects its qualifier node alongside the common placement. */
  projectQualifier?: (state: PlacementState, generation: string) => {
    iri: string; triples: readonly string[] } | null;
  /** Recover the qualifier on bounded edits of an existing placement. */
  hydrateQualifier?: (env: WorkActivationEnvironment, state: PlacementState) =>
    Promise<OccurrenceRecord['qualifier'] | undefined>;
  /** Owner profile SHACL checks for its projected qualifier nodes. */
  qualifierValidations?: (env: WorkActivationEnvironment,
    changed: readonly PlacementState[]) => Promise<CommandValidation[]>;
}

const book: StructureProfileRegistration = {
  id: 'book-composition', graphProfile: `${RV}BookComposition`,
  ownerType: 'https://schema.org/Book', componentType: `${RV}MainVersion`,
  componentPredicate: `${RV}mainVersion`, editScopePrefix: 'work:edit:',
  editPermission: 'work:edit', editAction: 'work.edit', receiptFamily: 'edit-metadata-work',
  catalogTargetTypes: ['https://schema.org/Book', 'https://schema.org/DigitalDocument'],
  roles: ['group', 'chapter'], targetRoles: ['chapter'], selectionRequiredRoles: ['chapter'],
};

function validUri(value: unknown): value is string {
  try { return typeof value === 'string' && /^https:\/\/[^\s<>"']+$/.test(value)
    && new URL(value).protocol === 'https:'; }
  catch { return false; }
}

export async function discoverStructureProfiles(directory = join(import.meta.dir, '..')) {
  const profiles = new Map<StructureProfile, StructureProfileRegistration>([[book.id, book]]);
  const graphProfiles = new Set([book.graphProfile]);
  for (const file of [...new Bun.Glob('*/structure-profile.ts').scanSync({ cwd: directory })].sort()) {
    const module = await import(resolve(directory, file)) as { structureProfiles?: unknown };
    if (!Array.isArray(module.structureProfiles) || !module.structureProfiles.length) {
      throw new Error(`Structure profile declaration is empty in ${file}`);
    }
    for (const candidate of module.structureProfiles) {
      const profile = candidate as Partial<StructureProfileRegistration>;
      if (typeof profile.id !== 'string' || !Object.hasOwn(PROFILE_ROLES, profile.id)
        || profiles.has(profile.id as StructureProfile)
        || !validUri(profile.graphProfile) || graphProfiles.has(profile.graphProfile)
        || !validUri(profile.ownerType) || !validUri(profile.componentType)
        || profile.componentPredicate !== undefined && !validUri(profile.componentPredicate)
        || profile.structurePredicate !== undefined && !validUri(profile.structurePredicate)
        || typeof profile.editScopePrefix !== 'string'
        || !/^[a-z][a-z0-9:-]*:$/.test(profile.editScopePrefix)
        || typeof profile.editPermission !== 'string'
        || !/^[a-z][a-z0-9.:-]{1,127}$/.test(profile.editPermission)
        || typeof profile.editAction !== 'string'
        || !/^[a-z][a-z0-9.:-]{1,127}$/.test(profile.editAction)
        || typeof profile.receiptFamily !== 'string'
        || !/^[a-z][a-z0-9-]{1,63}$/.test(profile.receiptFamily)
        || (profile.componentPredicate === undefined && profile.componentType !== profile.ownerType)
        || (profile.componentPredicate === undefined && profile.structurePredicate === undefined)
        || profile.catalogTargetTypes !== undefined
          && (!Array.isArray(profile.catalogTargetTypes)
            || profile.catalogTargetTypes.some(target => !validUri(target))
            || new Set(profile.catalogTargetTypes).size !== profile.catalogTargetTypes.length)
        || !Array.isArray(profile.roles) || !Array.isArray(profile.targetRoles)
        || profile.optionalTargetRoles !== undefined && !Array.isArray(profile.optionalTargetRoles)
        || profile.selectionRequiredRoles !== undefined && !Array.isArray(profile.selectionRequiredRoles)
        || !profile.roles.includes('group') || new Set(profile.roles).size !== profile.roles.length
        || new Set(profile.targetRoles).size !== profile.targetRoles.length
        || new Set(profile.optionalTargetRoles ?? []).size !== (profile.optionalTargetRoles?.length ?? 0)
        || new Set(profile.selectionRequiredRoles ?? []).size !== (profile.selectionRequiredRoles?.length ?? 0)
        || profile.roles.some(role => !PROFILE_ROLES[profile.id as StructureProfile].includes(role))
        || profile.targetRoles.some(role => !profile.roles?.includes(role))
        || profile.optionalTargetRoles?.some(role => !profile.roles?.includes(role)
          || profile.targetRoles?.includes(role))
        || profile.selectionRequiredRoles?.some(role => !profile.targetRoles?.includes(role))
        || (profile.projectQualifier === undefined) !== (profile.hydrateQualifier === undefined)
        || profile.projectQualifier !== undefined && typeof profile.projectQualifier !== 'function'
        || profile.hydrateQualifier !== undefined && typeof profile.hydrateQualifier !== 'function'
        || profile.qualifierValidations !== undefined
          && typeof profile.qualifierValidations !== 'function') {
        throw new Error(`Duplicate or invalid Structure profile in ${file}`);
      }
      profiles.set(profile.id as StructureProfile, profile as StructureProfileRegistration);
      graphProfiles.add(profile.graphProfile);
    }
  }
  return profiles;
}

const profiles = await discoverStructureProfiles();
const byGraph = new Map([...profiles.values()].map(profile => [profile.graphProfile, profile]));
const byAction = new Map<string, StructureProfileRegistration>();
for (const profile of profiles.values()) {
  if (byAction.has(profile.editAction)) throw new Error(`Duplicate Structure edit action ${profile.editAction}`);
  byAction.set(profile.editAction, profile);
}

export function structureProfileFor(id: string): StructureProfileRegistration {
  const profile = profiles.get(id as StructureProfile);
  if (!profile) throw new Error(`No registered Structure profile for ${id}`);
  return profile;
}

export function structureProfileForGraph(graphProfile: string): StructureProfileRegistration {
  const profile = byGraph.get(graphProfile);
  if (!profile) throw new Error(`No registered Structure graph profile for ${graphProfile}`);
  return profile;
}

export function structureProfileForAction(action: string): StructureProfileRegistration {
  const profile = byAction.get(action);
  if (!profile) throw new Error(`No registered Structure profile for action ${action}`);
  return profile;
}

export function isCatalogTarget(profile: StructureProfile | StructureProfileRegistration,
  target: string): boolean {
  const registration = typeof profile === 'string' ? structureProfileFor(profile) : profile;
  return registration.catalogTargetTypes?.includes(target) ?? false;
}
