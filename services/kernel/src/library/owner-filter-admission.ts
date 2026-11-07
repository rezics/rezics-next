/** Native admission identity is local to the original immutable admission object. */
import type { Pool } from 'pg';
import type { Actor } from '../request/access.ts';
import type { CollectionMemberAdmission } from './owner-filter.ts';
import type { CollectionRuleSource } from './collection-rules.ts';
export const nativeAdmissions = new WeakMap<
  CollectionMemberAdmission,
  Readonly<{
    actor: Actor;
    pool: Pool;
    deadline: number;
    retainedMeaning: boolean;
    source: CollectionRuleSource;
  }>
>();

/** Exact native grammar/family admission, not a permission verdict or a serializable capability.
 * Consumers must repeat ordinary current authority and Source/identity fences at their actual T.
 */
export function readNativeCollectionMemberAdmission(admission: CollectionMemberAdmission) {
  return nativeAdmissions.get(admission);
}
