import type {
  LibraryProfile as DefinitionsLibraryProfile,
  LibraryProfilePin as DefinitionsLibraryProfilePin,
  LibraryProgressMode,
  Release,
} from '@rezics/definitions';

export type LibraryProfileDescriptor = DefinitionsLibraryProfile;
export type LibraryProfilePin = DefinitionsLibraryProfilePin;
export type LibraryEntryStateDescriptor = NonNullable<LibraryProfileDescriptor['entryStateSet']>['states'][number];
export type LibraryProgressUnitDescriptor = NonNullable<
  LibraryProfileDescriptor['progress']
>['allowed'][number]['units'][number];
export type LibraryCopyKindDescriptor = NonNullable<LibraryProfileDescriptor['copies']>['kinds'][number];
export type LibraryCopyStatusDescriptor = LibraryCopyKindDescriptor['statuses'][number];

function profileAt(release: Release, profileId: string): LibraryProfileDescriptor | null {
  const profiles = release.libraryProfiles;
  return profiles && Object.hasOwn(profiles, profileId) ? (profiles[profileId] ?? null) : null;
}

export function selectLibraryProfile(release: Release, acceptingType: string): LibraryProfileDescriptor | null {
  const type = Object.hasOwn(release.types, acceptingType) ? release.types[acceptingType] : undefined;
  const profileId = type?.library?.profileId;
  return profileId === undefined ? null : profileAt(release, profileId);
}

export function resolveLibraryProfilePin(
  snapshot: { digest: string; release: Release },
  pin: LibraryProfilePin,
): LibraryProfileDescriptor | null {
  if (snapshot.digest !== pin.releaseDigest) return null;
  if (pin.provenance === 'legacy') return profileAt(snapshot.release, 'legacy-fixed-v1');

  const type = Object.hasOwn(snapshot.release.types, pin.acceptingType)
    ? snapshot.release.types[pin.acceptingType]
    : undefined;
  if (type?.library?.profileId !== pin.profileId) return null;
  return profileAt(snapshot.release, pin.profileId);
}

export function hasEntryState(profile: LibraryProfileDescriptor, stateId: string): boolean {
  return profile.entryStateSet?.states.some((state) => state.id === stateId) ?? false;
}

export function hasCopyStatus(profile: LibraryProfileDescriptor, kindId: string, statusId: string): boolean {
  const kind = profile.copies?.kinds.find((candidate) => candidate.id === kindId);
  return kind?.statuses.some((status) => status.id === statusId) ?? false;
}

export function progressUnit(
  profile: LibraryProfileDescriptor,
  mode: LibraryProgressMode,
  unitId: string,
): LibraryProgressUnitDescriptor | null {
  const allowedMode = profile.progress?.allowed.find((candidate) => candidate.mode === mode);
  return allowedMode?.units.find((unit) => unit.id === unitId) ?? null;
}
