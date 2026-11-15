import type { LibraryProfilePin } from './profile.ts';
/** Pin identity is independent of JSON/JSONB property order. */
export declare function sameLibraryProfilePin(left: LibraryProfilePin | null, right: LibraryProfilePin | null): boolean;
/** Decode private stored provenance without resolving current definitions. */
export declare function decodeLibraryProfilePin(value: unknown): LibraryProfilePin | null;
