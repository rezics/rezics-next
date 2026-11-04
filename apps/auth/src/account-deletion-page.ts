import { privateAuthRead } from './private-auth-read';

export type AccountDeletionPage =
  | { kind: 'authentication-required'; accountId: string }
  | {
      kind: 'review';
      accountId: string;
      email: string | null;
      action: 'available' | 'refused';
      policy: 'personal-deletion';
    }
  | { kind: 'signed-out' | 'refused' | 'changed' | 'unavailable' };
export type AccountDeletionPageSource = (signal: AbortSignal) => Promise<AccountDeletionPage>;
const unavailable: AccountDeletionPage = { kind: 'unavailable' };

export const loadAccountDeletionPage: AccountDeletionPageSource = async (signal) => {
  try {
    return await privateAuthRead(async (readSignal) => {
      const response = await fetch('/account-management/deletion-page', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
        signal: readSignal,
      });
      if (response.status !== 200) return unavailable;
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable;
      const row = value as Record<string, unknown>;
      const keys = Object.keys(row).sort().join(',');
      if (keys === 'kind' && ['signed-out', 'refused', 'changed', 'unavailable'].includes(String(row.kind)))
        return { kind: row.kind } as AccountDeletionPage;
      if (typeof row.accountId !== 'string' || !row.accountId || row.accountId.length > 128) return unavailable;
      if (keys === 'accountId,kind' && row.kind === 'authentication-required')
        return { kind: 'authentication-required', accountId: row.accountId };
      if (
        keys !== 'accountId,action,email,kind,policy' ||
        row.kind !== 'review' ||
        row.policy !== 'personal-deletion' ||
        (row.action !== 'available' && row.action !== 'refused') ||
        (row.email !== null &&
          (typeof row.email !== 'string' || row.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(row.email)))
      )
        return unavailable;
      return {
        kind: 'review',
        accountId: row.accountId,
        email: row.email as string | null,
        action: row.action,
        policy: 'personal-deletion',
      };
    }, signal);
  } catch {
    return unavailable;
  }
};
