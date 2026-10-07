import { record } from './account-data.ts';

export const guardianStates = [
  'pending',
  'accepted',
  'declined',
  'withdrawn',
  'cancelled',
  'spent',
  'unconfirmed',
  'expired',
] as const;
export type GuardianState = (typeof guardianStates)[number];
export interface RecoveryPolicyView {
  policy: null | {
    invitationId: string;
    guardianEmail: string;
    state: GuardianState;
    expiresAt: string;
    hasCode: boolean;
  };
}
export interface GuardianInvitation {
  invitationId: string;
  ownerEmail: string;
  state: 'pending' | 'accepted';
  expiresAt: string;
}
export interface GuardianPage {
  items: GuardianInvitation[];
  nextCursor: string | null;
}
export interface RecoveryEnrollment {
  guardianEmail: string;
  recoveryCode: string;
  previousRecoveryCode?: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const date = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

export function parseRecoveryPolicy(value: unknown): RecoveryPolicyView | null {
  const root = record(value);
  if (!root || !('policy' in root)) return null;
  if (root.policy === null) return { policy: null };
  const row = record(root.policy);
  if (
    !row ||
    typeof row.invitationId !== 'string' ||
    !uuid.test(row.invitationId) ||
    typeof row.guardianEmail !== 'string' ||
    !guardianStates.includes(row.state as GuardianState) ||
    !date(row.expiresAt) ||
    typeof row.hasCode !== 'boolean'
  )
    return null;
  return {
    policy: {
      invitationId: row.invitationId,
      guardianEmail: row.guardianEmail,
      state: row.state as GuardianState,
      expiresAt: row.expiresAt,
      hasCode: row.hasCode,
    },
  };
}

export function parseGuardianPage(value: unknown): GuardianPage | null {
  const root = record(value);
  if (
    !root ||
    !Array.isArray(root.items) ||
    (root.nextCursor !== null &&
      (typeof root.nextCursor !== 'string' || !uuid.test(root.nextCursor)))
  )
    return null;
  const items: GuardianInvitation[] = [];
  for (const item of root.items) {
    const row = record(item);
    if (
      !row ||
      typeof row.invitationId !== 'string' ||
      !uuid.test(row.invitationId) ||
      typeof row.ownerEmail !== 'string' ||
      (row.state !== 'pending' && row.state !== 'accepted') ||
      !date(row.expiresAt)
    )
      return null;
    items.push({
      invitationId: row.invitationId,
      ownerEmail: row.ownerEmail,
      state: row.state,
      expiresAt: row.expiresAt,
    });
  }
  return { items, nextCursor: root.nextCursor as string | null };
}
