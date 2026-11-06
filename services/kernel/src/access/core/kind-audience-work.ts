import {
  ACCESS_KIND_AUDIENCE_NATIVE_POINTS,
  ACCESS_KIND_AUDIENCE_STATEMENT_COUNT,
  EMPTY_ACCESS_WORK,
  type AccessWork,
  type AccessWorkDimensions,
} from '../contract/bounds.ts';
import type { AccessActor } from '../contract/index.ts';
import { addAccessWork } from './work.ts';
import { originalControlWork } from './original-work.ts';

export type KindAudienceFormulaShape = {
  readonly members: number;
  readonly groups: number;
  readonly roles: number;
  readonly assignment: boolean;
  readonly scope: boolean;
};

export function kindAudienceActorShape(actor: AccessActor, membershipLimit: number): KindAudienceFormulaShape {
  const members = actor.kind === 'account' ? (actor.requestedBy ? 2 : 1) : 0;
  const groups = members * membershipLimit;
  return {
    members,
    groups,
    roles: groups * 2,
    assignment: actor.kind === 'account' && actor.requestedBy !== null,
    scope: actor.kind === 'account' && actor.scopes.includes('collection:read'),
  };
}

export function kindAudienceOverhead(statementBytes: number): AccessWorkDimensions {
  return originalControlWork(
    0,
    ACCESS_KIND_AUDIENCE_NATIVE_POINTS,
    ACCESS_KIND_AUDIENCE_STATEMENT_COUNT,
    statementBytes,
  );
}

export function kindAudienceAccessWork(
  shape: KindAudienceFormulaShape,
  formula: AccessWork,
  extra: readonly AccessWork[],
): AccessWork {
  const values = [formula, ...extra];
  if (shape.members) values.push({ ...EMPTY_ACCESS_WORK, points: shape.members, bytes: shape.members * 128 });
  if (shape.groups) values.push({ ...EMPTY_ACCESS_WORK, points: shape.groups, bytes: shape.groups * 128 + 256 });
  if (shape.assignment) values.push({ ...EMPTY_ACCESS_WORK, bytes: 512 });
  return addAccessWork(...values);
}

export function identityRecoveryApplies(error: unknown, receiptKey: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'identity_epoch_unavailable' &&
    error.message ===
      `Accounts source: missing original ${receiptKey}; owner must recover native decision/pending or reversal custody`
  );
}

export function identityReceiptKey(receipt: { kind: string; account: string; receipt: string }): string {
  return JSON.stringify([receipt.kind, receipt.account, receipt.receipt]);
}
