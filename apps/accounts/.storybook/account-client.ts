import { fn } from 'storybook/test';
import type { AccountClient } from '../features/api/account-client.tsx';
import type { AccountApi } from '../features/api/client.ts';

const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });

/** A passkey autofill request waits, as a browser's does, until the person
 * picks a passkey or the page aborts it. */
export function pendingAutofill(signal?: AbortSignal) {
  return new Promise<{ ok: false; kind: 'cancelled'; status: number }>(resolve =>
    signal?.addEventListener('abort', () => resolve({ ok: false, kind: 'cancelled', status: 0 })));
}

/** Story parameter `account`: API outcomes to fake and spies to assert on. */
export interface FakeAccount { api?: Partial<AccountApi>; navigate?: (url: string) => void;
  refresh?: () => void; download?: (file: Blob, name: string) => void }

export const totpEnrollment = { totpURI: 'otpauth://totp/REZICS:ada%40example.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=REZICS',
  backupCodes: ['k3Hx7-Qm2pW', 'r9Tc4-Vn8sL', 'b2Yf6-Jd5hK', 'w7Pe3-Xa9gM', 'n4Zu8-Cq1tR', 'h6Ls2-Fk7vB',
    'd8Gm5-Ty3wN', 'q1Rv9-Ej6cP', 'u5Kb4-Hn2xS', 'z3Wd7-Lp8fA'] };

export function fakeAccountClient(fake: FakeAccount = {}): AccountClient {
  const api: AccountApi = {
    readRecoveryPolicy: () => ok({ policy: null }),
    readGuardianInvitations: () => ok({ items: [], nextCursor: null }),
    enrollRecovery: () => ok({ generation: '0', replayed: false }),
    changeGuardian: (_id, action) => ok({ state: action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'withdrawn', replayed: false }),
    signIn: () => ok({}), verifyTwoFactor: () => ok({}), signInWithPasskey: ({ conditional, signal }) => conditional ? pendingAutofill(signal) : ok({}), signUp: () => ok({}), acceptPolicies: () => ok(undefined), unsubscribe: () => ok(undefined),
    requestPasswordReset: () => ok(undefined), resetPassword: () => ok(undefined),
    requestRecovery: () => Promise.resolve({ ok: false, kind: 'unavailable', status: 503 }),
    readRecovery: () => Promise.resolve({ ok: false, kind: 'unavailable', status: 503 }),
    approveRecovery: () => Promise.resolve({ ok: false, kind: 'unavailable', status: 503 }),
    activateRecovery: (claimId) => ok({ claimId, recoveryGeneration: '1', replayed: false }),
    sendVerificationEmail: () => ok(undefined), signOut: () => ok(undefined),
    consent: () => ok({ redirect: 'https://app.example/callback?code=c' }),
    reauthenticate: () => ok(undefined), reauthenticateWithPasskey: () => ok(undefined),
    updateName: () => ok(undefined), setLocale: () => ok(undefined),
    setContentPreferences: () => Promise.resolve({ ok: false, kind: 'unavailable', status: 503 }),
    setDisplayPreferences: value => ok({ ...value, revision: value.revision + 1 }),
    changeEmail: () => ok(undefined),
    changePassword: () => ok(undefined), removePassword: () => ok(undefined), addPasskey: () => ok(undefined),
    renamePasskey: () => ok(undefined), removePasskey: () => ok(undefined), enableTotp: () => ok(totpEnrollment),
    confirmTotp: () => ok(undefined), renameTotp: () => ok(undefined), disableTotp: () => ok(undefined),
    regenerateBackupCodes: () => ok(totpEnrollment.backupCodes), revokeSession: () => ok(undefined),
    revokeSessions: () => ok(undefined),
    revokeOtherSessions: () => ok(undefined), revokeApp: () => ok(undefined), deleteAccount: () => ok(undefined),
    exportData: () => ok({ file: new Blob(['{}'], { type: 'application/json' }), name: 'rezics-account-2026-09-28.json' }),
    ...fake.api,
  };
  return { api, navigate: fake.navigate ?? fn(), refresh: fake.refresh ?? fn(), download: fake.download ?? fn() };
}
