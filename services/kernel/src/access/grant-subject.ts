import { routeOf } from '../route/route.ts';

/** A recipient predicate, never an account, credential owner or organization. */
export const ACTIVE_ACCOUNTS = Object.freeze({ kind: 'active_accounts' } as const);
export type GrantSubject =
  | typeof ACTIVE_ACCOUNTS
  | Readonly<{ kind: 'account'; id: string }>
  | Readonly<{ kind: 'organization'; id: string; role: 'owner' | 'member' }>;

// Native temporal primary keys require non-null components. This sentinel has
// meaning only with the explicit builtin discriminant; it is never an identity
// anchor, a Global Context or a directory lookup target.
const builtinId = '00000000-0000-0000-0000-000000000000';
export type StoredGrantSubject = { kind: 'identity' | 'active_accounts'; id: string; role: '' | 'owner' | 'member' };
export function grantSubject(subject: GrantSubject): StoredGrantSubject | null {
  if (!subject || typeof subject !== 'object') return null;
  if (subject.kind === 'active_accounts' && Object.keys(subject).length === 1)
    return { kind: 'active_accounts', id: builtinId, role: '' };
  if (subject.kind === 'account' && routeOf(subject.id) !== null && Object.keys(subject).length === 2)
    return { kind: 'identity', id: subject.id, role: '' };
  if (
    subject.kind === 'organization' &&
    routeOf(subject.id) !== null &&
    ['owner', 'member'].includes(subject.role) &&
    Object.keys(subject).length === 3
  )
    return { kind: 'identity', id: subject.id, role: subject.role };
  return null;
}
