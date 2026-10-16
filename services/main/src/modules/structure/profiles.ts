import type { SourceCorrespondenceVerifier } from './source-correspondence.ts';
import { join, resolve } from 'node:path';
import { bindStructureProfiles, STRUCTURE_LIMITS, type OccurrenceRole, type StructureProfile,
  type StructureQualifierSpec } from './format.ts';
import type { OccurrenceRecord } from './format.ts';
import type { RecipeMeasure } from './format.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import type { PlacementState } from './graph.ts';
import type { CommandValidation } from '../../infrastructure/fuseki.ts';
import type { ProfileId } from '../../infrastructure/profile.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import type { TargetReadSession } from '../target/resolve.ts';
import type { Selection } from './graph.ts';
import type { StructureReferencePolicy } from './local-references.ts';

export type StructureTargetReader = <T>(operation: (session: TargetReadSession) => Promise<T>) => Promise<T>;

export interface StructureTargetAuthority {
  /** Owner policies can distinguish the target's current structural type. */
  environment?: WorkActivationEnvironment;
  access: Pick<AccessAdmissionRegistry, 'canReadWork'>
    & Partial<Pick<AccessAdmissionRegistry, 'canPreviewWork' | 'canReadWorks' | 'canReadSemanticResource' | 'withOwnerAuthority' | 'canManageMedia'>>;
  principal: VerifiedPrincipal;
  actingSubject: string;
  target: string;
  targetReader?: StructureTargetReader;
}

/** The shared Structure graph and object format; owners declare only their profile-specific policy. */
export interface StructureProfileRegistration {
  id: StructureProfile;
  /** Value of rv:structureProfile in the current graph. */
  graphProfile: string;
  /** Explicit review for use as a Work-owned public Structure source. */
  workPublication?: true;
  /** The profile alone interprets source bytes and proves their exact Structure correspondence. */
  verifySourceCorrespondence?: SourceCorrespondenceVerifier;
  /** Optional semantic projection; delivery authority always follows the neutral dependency. */
  projectPublicationDependency?: (source: string, dependency: string) => string;
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
  /** Owner-reviewed identities outside the native graph namespace. */
  targetPattern?: RegExp;
  validateSelection?: (reader: StructureTargetReader, target: string, selection: Selection) => Promise<void>;
  /** Existing reader used when disclosing occurrence targets. */
  targetDisclosure?: 'work' | 'resource' | 'structure-target';
  /** Owner target invariants, checked before planning and again inside the graph transaction. */
  targetGuard?: (env: WorkActivationEnvironment, owner: string, targets: readonly string[]) =>
    Promise<{ guard: string; rejection: string; invalid?: boolean }>;
  /** Withhold unreadable uses entirely, including aggregate counts and ordinals. */
  withholdUnreadableTargets?: boolean;
  /** Access action and graph receipt family for owner edits. */
  editAction: string;
  receiptFamily: string;
  /** Access scope on the authority resource. */
  editScopePrefix: string;
  /** Declared external catalog terms accepted as non-content occurrence targets. */
  catalogTargetTypes?: readonly string[];
  roles: readonly OccurrenceRole[];
  localReferences?: StructureReferencePolicy;
  /** Owner transitions may atomically clear references while retiring a use. */
  mixedOperationKinds?: readonly (readonly string[])[];
  /** Roles that may parent other occurrences. Defaults to `group`. */
  containerRoles?: readonly OccurrenceRole[];
  /** Qualifier required or optional on a role. Absent means the role carries none. */
  qualifiers?: Readonly<Record<string, StructureQualifierSpec>>;
  /** The manifest retains recipe measures only when the profile declares them. */
  measures?: boolean;
  /** The owning profile projects its retained facts at each exact revision. */
  projectRevisionFacts?: (measures: readonly RecipeMeasure[], revision: string, owner: string) => string;
  /** Owners with several fact subjects per occurrence use smaller projection batches. */
  projectionBatchRecords?: number;
  /** Completion is present only when the profile declares it. */
  completion?: boolean;
  /** These roles may omit a target; all other non-target roles forbid it. */
  optionalTargetRoles?: readonly OccurrenceRole[];
  targetRoles: readonly OccurrenceRole[];
  /** Leaves selected by navigation; omitted means all declared non-container roles. */
  readingRoles?: readonly OccurrenceRole[];
  /** Target roles selecting Content require an explicit/follow-context revision policy. */
  selectionRequiredRoles?: readonly OccurrenceRole[];
  /** Owner shapes replace only Structure/placement checks when extending kernel enums. */
  topologyValidationProfile?: ProfileId;
  /** These roles may retain a Content pin, but resource membership needs no pin. */
  selectionOptionalRoles?: readonly OccurrenceRole[];
  selectionSelectorRoles?: readonly OccurrenceRole[];
  /** Field-specific owner forms, also used for retained and staged objects. */
  checkOccurrence?: (record: Pick<OccurrenceRecord, 'role' | 'target' | 'selection' | 'qualifier'>) => void;
  /** An owner projects its qualifier node alongside the common placement. */
  projectQualifier?: (state: PlacementState, generation: string) => {
    iri: string; triples: readonly string[] } | null;
  /** Owner facts may have RDF set or canonical value semantics. */
  canonicalQualifier?: (qualifier: NonNullable<OccurrenceRecord['qualifier']>) => NonNullable<OccurrenceRecord['qualifier']>;
  /** Recover the qualifier on bounded edits of an existing placement. */
  hydrateQualifier?: (env: WorkActivationEnvironment, state: PlacementState) =>
    Promise<OccurrenceRecord['qualifier'] | undefined>;
  /** Owner topology prechecks and SHACL checks for projected qualifier nodes.
   * Replacements pass all candidate placements, including across stage batches.
   */
  qualifierValidations?: (env: WorkActivationEnvironment,
    changed: readonly PlacementState[], context?: {
      structure: string; generation: string;
      /** A replacement validates its complete candidate, never the live generation. */
      replacement: boolean;
      placements?: readonly PlacementState[];
    }) => Promise<CommandValidation[]>;
  /**
   * Occurrence levels below the Structure, when the owner allows fewer than the shared
   * limit. A group never sits on the last level, where it could hold nothing.
   */
  maxDepth?: number;
}

/** The deepest level an occurrence of this role may take in a profile's Structure (1 = under the root). */
export function deepestLevel(profile: StructureProfileRegistration, role: OccurrenceRole): number {
  if (profile.maxDepth === undefined) return STRUCTURE_LIMITS.maxDepth;
  return isContainerRole(profile, role) ? profile.maxDepth - 1 : profile.maxDepth;
}

/** A container role may parent other occurrences. Persisted profiles use `group`. */
export function isContainerRole(profile: StructureProfileRegistration | string, role: string): boolean {
  const registration = typeof profile === 'string' ? structureProfileFor(profile) : profile;
  return (registration.containerRoles ?? ['group']).includes(role);
}

export function isReadingRole(profile: StructureProfileRegistration, role: string): boolean {
  return (profile.readingRoles ?? profile.roles.filter(item => !isContainerRole(profile, item))).includes(role);
}

/** Attached profiles own their type prerequisites, including profiles added after Work shipped. */
export function structureTypeRemovalGuard(work: string, retainedTypes: readonly string[]): string {
  const required = [...profiles.values()].filter(profile => !retainedTypes.includes(profile.ownerType));
  if (!required.length) return '';
  return `FILTER NOT EXISTS { GRAPH <urn:rezics:graph:current> {
    ${required.map(profile => `{
      ?dependentStructure a <https://rezics.com/vocab/Structure> ;
        <https://rezics.com/vocab/structureProfile> <${profile.graphProfile}> ;
        <https://rezics.com/vocab/structureOf> ${profile.componentPredicate ? '?dependentComponent' : `<${work}>`} .
      ${profile.componentPredicate ? `<${work}> <${profile.componentPredicate}> ?dependentComponent .` : ''}
      ${profile.structurePredicate ? `<${work}> <${profile.structurePredicate}> ?dependentStructure .` : ''}
    }`).join(' UNION ')}
  } }`;
}

function validUri(value: unknown): value is string {
  try { return typeof value === 'string' && /^https:\/\/[^\s<>"']+$/.test(value)
    && new URL(value).protocol === 'https:'; }
  catch { return false; }
}

const profileIdPattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export async function discoverStructureProfiles(directory = join(import.meta.dir, '..')) {
  const profiles = new Map<StructureProfile, StructureProfileRegistration>();
  const graphProfiles = new Set<string>();
  for (const file of [...new Bun.Glob('*/structure-profile.ts').scanSync({ cwd: directory })].sort()) {
    const module = await import(resolve(directory, file)) as { structureProfiles?: unknown };
    if (!Array.isArray(module.structureProfiles) || !module.structureProfiles.length) {
      throw new Error(`Structure profile declaration is empty in ${file}`);
    }
    for (const candidate of module.structureProfiles) {
      const profile = candidate as Partial<StructureProfileRegistration>;
      const containers = profile.containerRoles ?? ['group'];
      if (typeof profile.id !== 'string' || !profileIdPattern.test(profile.id) || profile.id.length > 64
        || profiles.has(profile.id as StructureProfile)
        || !validUri(profile.graphProfile) || graphProfiles.has(profile.graphProfile)
        || profile.workPublication !== undefined && profile.workPublication !== true
        || profile.verifySourceCorrespondence !== undefined && typeof profile.verifySourceCorrespondence !== 'function'
        || profile.projectPublicationDependency !== undefined && typeof profile.projectPublicationDependency !== 'function'
        || profile.workPublication === true
          && (profile.componentType !== 'https://rezics.com/vocab/MainVersion'
            || profile.componentPredicate !== 'https://rezics.com/vocab/mainVersion'
            || profile.structurePredicate !== undefined)
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
        || profile.targetGuard !== undefined && typeof profile.targetGuard !== 'function'
        || profile.withholdUnreadableTargets !== undefined && typeof profile.withholdUnreadableTargets !== 'boolean'
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
        || profile.selectionOptionalRoles !== undefined && !Array.isArray(profile.selectionOptionalRoles)
        || profile.readingRoles !== undefined && (!Array.isArray(profile.readingRoles)
          || profile.readingRoles.some(role => !profile.roles?.includes(role) || containers.includes(role))
          || new Set(profile.readingRoles).size !== profile.readingRoles.length)
        || !containers.length || containers.some(role => !profile.roles?.includes(role))
        || new Set(profile.roles).size !== profile.roles.length
        || new Set(profile.targetRoles).size !== profile.targetRoles.length
        || new Set(profile.optionalTargetRoles ?? []).size !== (profile.optionalTargetRoles?.length ?? 0)
        || new Set(profile.selectionRequiredRoles ?? []).size !== (profile.selectionRequiredRoles?.length ?? 0)
        || new Set(profile.selectionOptionalRoles ?? []).size !== (profile.selectionOptionalRoles?.length ?? 0)
        || profile.roles.some(role => typeof role !== 'string' || !profileIdPattern.test(role))
        || profile.qualifiers !== undefined && (typeof profile.qualifiers !== 'object'
          || Object.entries(profile.qualifiers).some(([role, spec]) => !profile.roles?.includes(role)
            || !spec || typeof spec.type !== 'string' || typeof spec.required !== 'boolean'))
        || profile.measures !== undefined && typeof profile.measures !== 'boolean'
        || profile.completion !== undefined && typeof profile.completion !== 'boolean'
        || profile.targetDisclosure !== undefined && profile.targetDisclosure !== 'work'
          && profile.targetDisclosure !== 'resource' && profile.targetDisclosure !== 'structure-target'
        || profile.targetRoles.some(role => !profile.roles?.includes(role))
        || profile.optionalTargetRoles?.some(role => !profile.roles?.includes(role)
          || profile.targetRoles?.includes(role))
        || profile.selectionRequiredRoles?.some(role => !profile.targetRoles?.includes(role))
        || profile.selectionOptionalRoles?.some(role => (!profile.targetRoles?.includes(role)
          && !profile.optionalTargetRoles?.includes(role))
          || profile.selectionRequiredRoles?.includes(role))
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
bindStructureProfiles(profiles);
const byGraph = new Map([...profiles.values()].map(profile => [profile.graphProfile, profile]));
const byAction = new Map<string, StructureProfileRegistration>();
for (const profile of profiles.values()) {
  const prior = byAction.get(profile.editAction);
  if (prior && prior.receiptFamily !== profile.receiptFamily) {
    throw new Error(`Inconsistent Structure receipt family for ${profile.editAction}`);
  }
  if (!prior) byAction.set(profile.editAction, profile);
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

/** Resolve only profiles whose owner reviewed the Work-publication source contract. */
export function workPublicationProfileFor(
  profileOrId: string | StructureProfileRegistration,
): StructureProfileRegistration {
  const profile = typeof profileOrId === 'string' ? structureProfileFor(profileOrId) : profileOrId;
  if (profile.workPublication !== true) {
    throw new Error(`Structure profile ${profile.id} is not reviewed for Work publication`);
  }
  return profile;
}

/** Receipt-family representative only; command policy comes from the Structure's own profile. */
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
  return (await canReadStructureTargets(profile, authority, [authority.target])).has(authority.target);
}

/** Owner hooks remain the decision for their distinct targets; the default
 * Work decision uses Access's batch, whose scalar entry is a batch of one. */
export async function canReadStructureTargets(profile: StructureProfileRegistration,
  authority: Omit<StructureTargetAuthority, 'target'>, targets: readonly string[]): Promise<ReadonlySet<string>> {
  const distinct = [...new Set(targets)];
  const readable = new Set(distinct.filter(target => isCatalogTarget(profile, target)));
  const native = distinct.filter(target => !readable.has(target)
    && (profile.targetPattern ?? /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/).test(target));
  if (!native.length) return readable;
  if (!profile.authorizeTarget && authority.access.canReadWorks) {
    const allowed = await authority.access.canReadWorks(authority.principal, authority.actingSubject, native);
    for (const target of native) if (allowed.has(target)) readable.add(target);
    return readable;
  }
  const { WorkReadMissing } = await import('../work/read-session.ts');
  for (const target of native) {
    try {
      if (profile.authorizeTarget
        ? await profile.authorizeTarget({ ...authority, target })
        : await authority.access.canReadWork(authority.principal, authority.actingSubject, target)) {
        readable.add(target);
      }
    } catch (error) {
      if (!(error instanceof WorkReadMissing)) throw error;
    }
  }
  return readable;
}
