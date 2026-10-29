import type { LibraryProfile as DefinitionsLibraryProfile, LibraryProfilePin as DefinitionsLibraryProfilePin, LibraryProgressMode, Release } from '@rezics/definitions';
export type LibraryProfileDescriptor = DefinitionsLibraryProfile;
export type LibraryProfilePin = DefinitionsLibraryProfilePin;
export type LibraryEntryStateDescriptor = NonNullable<LibraryProfileDescriptor['entryStateSet']>['states'][number];
export type LibraryProgressUnitDescriptor = NonNullable<LibraryProfileDescriptor['progress']>['allowed'][number]['units'][number];
export type LibraryCopyKindDescriptor = NonNullable<LibraryProfileDescriptor['copies']>['kinds'][number];
export type LibraryCopyStatusDescriptor = LibraryCopyKindDescriptor['statuses'][number];
export declare function selectLibraryProfile(release: Release, acceptingType: string): LibraryProfileDescriptor | null;
export declare function resolveLibraryProfilePin(snapshot: {
    digest: string;
    release: Release;
}, pin: LibraryProfilePin): LibraryProfileDescriptor | null;
export declare function hasEntryState(profile: LibraryProfileDescriptor, stateId: string): boolean;
export declare function hasCopyStatus(profile: LibraryProfileDescriptor, kindId: string, statusId: string): boolean;
export declare function progressUnit(profile: LibraryProfileDescriptor, mode: LibraryProgressMode, unitId: string): LibraryProgressUnitDescriptor | null;
