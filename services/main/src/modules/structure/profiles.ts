import { join, resolve } from 'node:path';
import { RV } from '../work/activate.ts';
import { PROFILE_ROLES, type OccurrenceRole, type StructureProfile } from './format.ts';

/** The shared Structure graph and object format; owners declare only their profile-specific policy. */
export interface StructureProfileRegistration {
  id: StructureProfile;
  /** Value of rv:structureProfile in the current graph. */
  graphProfile: string;
  /** Type of the authority resource and its relationship to structureOf. */
  ownerType: string;
  componentType: string;
  componentPredicate: string;
  /** Access scope on the authority resource. Admission remains the caller's responsibility. */
  editScopePrefix: string;
  roles: readonly OccurrenceRole[];
  targetRoles: readonly OccurrenceRole[];
}

const book: StructureProfileRegistration = {
  id: 'book-composition', graphProfile: `${RV}BookComposition`,
  ownerType: 'https://schema.org/Book', componentType: `${RV}MainVersion`,
  componentPredicate: `${RV}mainVersion`, editScopePrefix: 'work:edit:',
  roles: ['group', 'chapter'], targetRoles: ['chapter'],
};

function validUri(value: unknown): value is string {
  try { return typeof value === 'string' && new URL(value).protocol === 'https:'; }
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
        || !validUri(profile.componentPredicate)
        || typeof profile.editScopePrefix !== 'string'
        || !/^[a-z][a-z0-9:-]*:$/.test(profile.editScopePrefix)
        || !Array.isArray(profile.roles) || !Array.isArray(profile.targetRoles)
        || !profile.roles.includes('group') || new Set(profile.roles).size !== profile.roles.length
        || new Set(profile.targetRoles).size !== profile.targetRoles.length
        || profile.roles.some(role => !PROFILE_ROLES[profile.id as StructureProfile].includes(role))
        || profile.targetRoles.some(role => !profile.roles?.includes(role))) {
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
