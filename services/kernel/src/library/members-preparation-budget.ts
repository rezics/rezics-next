import { ProblemError } from '../http/problem.ts';
import type { WorkDimensions } from './collection-source.ts';
import { NativeCollectionWork } from './collection-source-work.ts';

/** Disjoint owner declarations, including failed prefixes and terminal controls. A missing
 * declaration is unknown, never zero. History's local declaration does not price other owners.
 */
export const MEMBERS_PREPARATION_CHILDREN = [
  'members',
  'historyRegistration',
  'receivingReadback',
  'core',
  'access',
  'sourceResolve',
  'sourceVerify',
  'executor',
  'retry',
  'rollback',
  'cleanup',
] as const;
export type MembersPreparationChild = (typeof MEMBERS_PREPARATION_CHILDREN)[number];
export type MembersPreparationDeclarations = Readonly<Record<MembersPreparationChild, WorkDimensions | null>>;

const registered = new WeakMap<NativeCollectionWork, Set<string>>();

/** C3 accounting seam for the retained producer: all children come from one existing finite
 * parent before checkout. It neither opens a connection nor issues History registration.
 * The producer must still bind the durable preparation key and freshly verify physical Source
 * authority. A complete accounting frame is not evidence that those dependencies are released.
 */
export function transferMembersPreparationBudget(
  parent: NativeCollectionWork,
  preparationKey: string,
  declarations: MembersPreparationDeclarations,
) {
  if (!preparationKey || registered.get(parent)?.has(preparationKey)) throw new ProblemError('dependency_unavailable');
  const complete = Object.create(null) as Record<MembersPreparationChild, WorkDimensions>;
  for (const name of MEMBERS_PREPARATION_CHILDREN) {
    const declaration = declarations[name];
    if (!declaration) throw new ProblemError('dependency_unavailable');
    complete[name] = declaration;
  }
  const transferred = parent.transferChildren(complete);
  const keys = registered.get(parent) ?? new Set<string>();
  keys.add(preparationKey);
  registered.set(parent, keys);
  return transferred;
}
