import { join, resolve } from 'node:path';
import { RV } from '../work/activate.ts';
import { PROFILE_ROLES, STRUCTURE_LIMITS, type OccurrenceRole, type StructureProfile } from './format.ts';
import type { OccurrenceRecord } from './format.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import type { PlacementState } from './graph.ts';
import type { CommandValidation } from '../../infrastructure/fuseki.ts';
import type { ProfileId } from '../../infrastructure/profile.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import { hydrateBookGroup, projectBookGroup, validateBookGroups } from './book-group.ts';

export interface StructureTargetAuthority {
  access: Pick<AccessAdmissionRegistry, 'canReadWork'>
    & Partial<Pick<AccessAdmissionRegistry, 'canReadSemanticResource'>>;
  principal: VerifiedPrincipal;
  actingSubject: string;
  target: string;
}

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
  /** Validation of the owner when Structure creation adds its Structure link. */
  ownerValidation?: { profile: ProfileId; shape: string };
  /** Account OAuth scope needed for owner edits. */
  editPermission: string;
  /** Additional OAuth scope required when reading an occurrence target. */
  targetReadPermission?: string;
  /** Current target disclosure. The Book default remains work:read. */
  authorizeTarget?: (authority: StructureTargetAuthority) => Promise<boolean>;
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
  /**
   * Occurrence levels below the Structure, when the owner allows fewer than the shared
   * limit. A group never sits on the last level, where it could hold nothing.
   */
  maxDepth?: number;
}

const book: StructureProfileRegistration = {
  id: 'book-composition', graphProfile: `${RV}BookComposition`,
  ownerType: 'https://schema.org/Book', componentType: `${RV}MainVersion`,
  componentPredicate: `${RV}mainVersion`, editScopePrefix: 'work:edit:',
  editPermission: 'work:edit', editAction: 'work.edit', receiptFamily: 'edit-metadata-work',
  targetReadPermission: 'work:read',
  catalogTargetTypes: ['https://schema.org/Book', 'https://schema.org/DigitalDocument'],
  roles: ['group', 'chapter'], targetRoles: ['chapter'], selectionRequiredRoles: ['chapter'],
  // Volumes, parts and extras sit directly under the book; chapters under the book or one group.
  maxDepth: 2,
  projectQualifier: projectBookGroup, hydrateQualifier: hydrateBookGroup,
  qualifierValidations: validateBookGroups,
};

/** The deepest level an occurrence of this role may take in a profile's Structure (1 = under the root). */
export function deepestLevel(profile: StructureProfileRegistration, role: OccurrenceRole): number {
  if (profile.maxDepth === undefined) return STRUCTURE_LIMITS.maxDepth;
  return role === 'group' ? profile.maxDepth - 1 : profile.maxDepth;
}

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
        || Boolean(profile.structurePredicate) !== Boolean(profile.ownerValidation)
        || profile.ownerValidation !== undefined
          && (!validUri(profile.ownerValidation.shape)
            || typeof profile.ownerValidation.profile !== 'string')
        || typeof profile.editScopePrefix !== 'string'
        || !/^[a-z][a-z0-9:-]*:$/.test(profile.editScopePrefix)
        || typeof profile.editPermission !== 'string'
        || !/^[a-z][a-z0-9.:-]{1,127}$/.test(profile.editPermission)
        || profile.targetReadPermission !== undefined
          && !/^[a-z][a-z0-9.:-]{1,127}$/.test(profile.targetReadPermission)
        || profile.authorizeTarget !== undefined && typeof profile.authorizeTarget !== 'function'
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
          && typeof profile.qualifierValidations !== 'function'
        || profile.maxDepth !== undefined && (!Number.isInteger(profile.maxDepth) || profile.maxDepth < 2
          || profile.maxDepth > STRUCTURE_LIMITS.maxDepth)) {
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

/** Every non-catalog target needs its owner's current disclosure decision. */
export async function canReadStructureTarget(profile: StructureProfileRegistration,
  authority: StructureTargetAuthority): Promise<boolean> {
  if (isCatalogTarget(profile, authority.target)) return true;
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(authority.target)) return false;
  return profile.authorizeTarget
    ? profile.authorizeTarget(authority)
    : authority.access.canReadWork(authority.principal, authority.actingSubject, authority.target);
}
