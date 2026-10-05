/** Shared media errors and selection context do not depend on owner stores. */
export class MediaInvalid extends Error {}
export class MediaConflict extends Error {}
export class MediaStale extends Error {}
export class MediaMissing extends Error {}
export class MediaUnavailable extends Error {}
export class MediaFenced extends Error {}
export const DEFAULT_MEDIA_CONTEXT = 'urn:rezics:media:context:default';
export const AVATAR_POLICY = 'avatar-selection-v1';
