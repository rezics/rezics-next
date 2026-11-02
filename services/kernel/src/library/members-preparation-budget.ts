import { ProblemError } from '../http/problem.ts';
import {
  OPERATIONAL_WORK_AXES,
  OPERATIONAL_WORK_COST,
  OPERATIONAL_WORK_REGISTRATION,
  OPERATIONAL_WORK_RECEIVING,
  OPERATIONAL_WORK_TRANSFER_COST,
  sumOperationalWork,
} from '../history/operational-work-budget.ts';
import type { WorkDimensions } from './collection-source.ts';
import { NativeCollectionWork } from './collection-source-work.ts';

/** Disjoint owner declarations, including failed prefixes and terminal controls. A missing
 * declaration is unknown, never zero. History's local declaration does not price other owners.
 */
export const MEMBERS_PREPARATION_CHILDREN = [
  'members',
  'historyRegistration',
  'receivingReadback',
  'historyResolve',
  'historyVerify',
  'historyReplay',
  'historyRetirement',
  'core',
  'access',
  'sourceResolve',
  'sourceVerify',
  'executor',
  'selectedRuntime',
  'transferControls',
  'retry',
  'rollback',
  'cleanup',
] as const;
export type MembersPreparationChild = (typeof MEMBERS_PREPARATION_CHILDREN)[number];
export type MembersPreparationDeclarations = Readonly<Record<MembersPreparationChild, WorkDimensions | null>>;

const history = Object.freeze({
  historyRegistration: OPERATIONAL_WORK_REGISTRATION,
  receivingReadback: OPERATIONAL_WORK_RECEIVING,
  historyResolve: OPERATIONAL_WORK_TRANSFER_COST.resolve,
  historyVerify: OPERATIONAL_WORK_TRANSFER_COST.verify,
  historyReplay: OPERATIONAL_WORK_TRANSFER_COST.replay,
  historyRetirement: OPERATIONAL_WORK_TRANSFER_COST.retirement,
  executor: OPERATIONAL_WORK_COST.attempt,
});
export type MembersPreparationOwnerDeclarations = Omit<MembersPreparationDeclarations, keyof typeof history>;

function snapshot(value: WorkDimensions | null): WorkDimensions {
  if (!value) throw new ProblemError('dependency_unavailable');
  const declared = { ...value };
  if (
    OPERATIONAL_WORK_AXES.some(
      (axis) => !Object.hasOwn(declared, axis) || !Number.isSafeInteger(declared[axis]) || declared[axis] < 0,
    )
  )
    throw new TypeError('Incomplete Members preparation declaration');
  return Object.freeze({
    candidateKeys: declared.candidateKeys,
    nativeRows: declared.nativeRows,
    identityMetadataRows: declared.identityMetadataRows,
    emptySeeks: declared.emptySeeks,
    nativePoints: declared.nativePoints,
    witnessKeys: declared.witnessKeys,
    statements: declared.statements,
    bytes: declared.bytes,
  });
}

/** Prices one complete original before I/O, without allocating a second payer or granting authority.
 * Core/Access, released Source, selected-runtime and cleanup have no guessed default declaration.
 * Retry/rollback declarations include all additional failed prefixes and controls, including repeated
 * History bodies. They preserve the native request deadline policy rather than imposing a new retry cap.
 */
export function declareMembersPreparationParent(owners: MembersPreparationOwnerDeclarations): Readonly<{
  children: Readonly<Record<MembersPreparationChild, WorkDimensions>>;
  total: WorkDimensions;
}> {
  const children = Object.create(null) as Record<MembersPreparationChild, WorkDimensions>;
  for (const name of MEMBERS_PREPARATION_CHILDREN) {
    const declaration = Object.hasOwn(history, name)
      ? history[name as keyof typeof history]
      : Object.hasOwn(owners, name)
        ? owners[name as keyof typeof owners]
        : null;
    children[name] = snapshot(declaration);
  }
  if (children.members.statements > 16) throw new TypeError('Members preparation body exceeds 16 statements');
  const total = snapshot(sumOperationalWork(...Object.values(children)));
  return Object.freeze({ children: Object.freeze(children), total });
}

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
    const declaration = Object.hasOwn(declarations, name) ? declarations[name] : null;
    complete[name] = snapshot(declaration);
  }
  const transferred = parent.transferChildren(complete);
  const keys = registered.get(parent) ?? new Set<string>();
  keys.add(preparationKey);
  registered.set(parent, keys);
  return transferred;
}
