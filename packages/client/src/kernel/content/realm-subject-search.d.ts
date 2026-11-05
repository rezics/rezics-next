import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import { createRealmSubjectSource, type RealmSubjectSource } from './realm-subject-source.ts';
/**
 * Compose the finite Content Realm census, current disclosure and live lifecycle for one actual reader.
 * Search receives no native locator or copied authorization evidence from this adapter.
 */
export declare function createRealmSubjectSearchSource(input: {
    pool: Parameters<typeof createRealmSubjectSource>[0]['pool'];
    reader: LeafOptions;
}): RealmSubjectSource | undefined;
