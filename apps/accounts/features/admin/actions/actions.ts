import type { AdminAction, AdminMe, BulkAction, OperatorRole, UserStatus } from '../api/types.ts';

type Permission = AdminMe['permissions'][number];

/** Friction matches damage: low is one confirmation; medium names the user
 * and the consequence and needs a reason; high also needs the user's email
 * typed and the operator's password. */
export const damage = { suspend: 'high', 'require-password-reset': 'high', unsuspend: 'medium',
  'revoke-sessions': 'medium', 'resend-verification': 'low', 'add-note': 'low' } as const satisfies
  Record<AdminAction, 'low' | 'medium' | 'high'>;

/** The permission the Account service checks for each action. */
export const actionPermission = { suspend: 'users:suspend', unsuspend: 'users:suspend', 'revoke-sessions': 'sessions:revoke',
  'require-password-reset': 'password:require-reset', 'resend-verification': 'verification:send', 'add-note': 'notes:write',
} as const satisfies Record<AdminAction, Permission>;

/** Sanctions need a reason code and may message the user. */
export const sanctions: readonly AdminAction[] = ['suspend', 'unsuspend', 'revoke-sessions', 'require-password-reset'];
export const bulkActionOrder: readonly BulkAction[] = ['suspend', 'unsuspend', 'revoke-sessions', 'require-password-reset',
  'resend-verification'];

export interface ActionTarget { id: string; name: string; email: string; status: UserStatus; emailVerified: boolean;
  role: OperatorRole | null }

/** What this operator can do to this user now: permitted by their role, not
 * blocked because the user is staff (only owners act on staff), and relevant
 * to the user's state. */
export function availableActions(target: ActionTarget, me: Pick<AdminMe, 'role' | 'permissions'>): AdminAction[] {
  if (target.role && me.role !== 'owner') return me.permissions.includes('notes:write') ? ['add-note'] : [];
  const relevant: AdminAction[] = [target.status === 'suspended' ? 'unsuspend' : 'suspend', 'revoke-sessions',
    ...(target.status === 'password-reset-required' ? [] : ['require-password-reset' as const]),
    ...(target.emailVerified ? [] : ['resend-verification' as const]), 'add-note'];
  return relevant.filter(action => me.permissions.includes(actionPermission[action]));
}

const durations = { day: 1, week: 7, month: 30, quarter: 90 } as const;
export type Duration = keyof typeof durations | 'indefinite' | 'custom';

/** When a suspension of this duration ends, or undefined for “until lifted”. */
export function suspensionEnd(duration: Duration, customDate: string, now = Date.now()): string | undefined | null {
  if (duration === 'indefinite') return undefined;
  if (duration === 'custom') {
    const end = Date.parse(`${customDate}T00:00:00`);
    return Number.isNaN(end) || end <= now ? null : new Date(end).toISOString();
  }
  return new Date(now + durations[duration] * 86_400_000).toISOString();
}

/** What a bulk action would do to one selected user, judged from the row the
 * operator sees: change them, leave them as they are (already in that state;
 * suspending again would replace a suspension's end), or refuse (staff need
 * an owner). The job's per-user results remain the truth. */
export type BulkOutcome = 'change' | 'unchanged' | 'staff';
export function bulkOutcome(action: BulkAction, target: ActionTarget, me: Pick<AdminMe, 'role'>): BulkOutcome {
  if (target.role && me.role !== 'owner') return 'staff';
  const already = { suspend: target.status === 'suspended', unsuspend: target.status !== 'suspended',
    'require-password-reset': target.status === 'password-reset-required', 'resend-verification': target.emailVerified,
    'revoke-sessions': false }[action];
  return already ? 'unchanged' : 'change';
}

/** Seconds a bulk action waits before its first change, so it can be undone whole. */
export const bulkUndoSeconds = 10;
