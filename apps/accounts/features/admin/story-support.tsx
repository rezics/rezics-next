// Fixtures and a fake Account operator API for the panel's stories. Stories
// render real components inside the real shell; only the network is faked.
import type { Decorator } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AdminClientProvider, type AdminClient } from './api/admin-client.tsx';
import type { AdminApi, AdminResult } from './api/client.ts';
import type { AdminMe, AdminUser, AuditEntry, AuditPage, ClientPage, Job, Operators, Overview, UserDetail } from './api/types.ts';
import { AdminShell, type AdminSection } from './shell/admin-shell.tsx';

const now = Date.now();
export const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
export const ahead = (days: number) => new Date(now + days * 86_400_000).toISOString();
const ok = <T,>(data: T): Promise<AdminResult<T>> => Promise.resolve({ ok: true, data });

export const owner: AdminMe = {
  role: 'owner', permissions: ['users:read', 'users:suspend', 'sessions:revoke', 'password:require-reset', 'verification:send',
    'notes:write', 'clients:manage', 'audit:read', 'operators:manage'], secondFactor: false, stepUpUntil: null,
  reasonCodes: { suspend: ['spam', 'abuse', 'fraud', 'impersonation', 'legal', 'compromised', 'other'],
    unsuspend: ['appeal', 'error-correction', 'other'], 'revoke-sessions': ['compromised', 'user-request', 'support', 'other'],
    'require-password-reset': ['compromised', 'user-request', 'support', 'other'], 'resend-verification': ['user-request', 'support', 'other'],
    'add-note': ['support', 'other'] },
  bulkActions: ['suspend', 'unsuspend', 'revoke-sessions', 'require-password-reset', 'resend-verification'], bulkLimit: 100,
};
export const support: AdminMe = { ...owner, role: 'support',
  permissions: ['users:read', 'sessions:revoke', 'verification:send', 'notes:write'] };
export const operatorUser = { name: 'Olive Operator', email: 'olive@rezics.test', image: null };

const person = (id: string, name: string, email: string, extra: Partial<AdminUser> = {}): AdminUser => ({
  id, name, email, image: null, emailVerified: true, twoFactorEnabled: false, createdAt: ago(60 * 24 * 40), updatedAt: ago(60 * 5),
  passwordResetRequired: false, suspendedUntil: null, suspensionReason: null, status: 'active', role: null, suspendedAt: null,
  suspensionCode: null, lastSignInAt: ago(90), ...extra });
export const users: AdminUser[] = [
  person('u-ada', 'Ada Lovelace', 'ada@example.test', { twoFactorEnabled: true }),
  person('u-li', '李明', 'li.ming@example.test', { lastSignInAt: null }),
  person('u-radia', 'Radia Perlman', 'radia@example.test', { status: 'suspended', suspendedAt: ago(120), suspendedUntil: ahead(3),
    suspensionReason: 'Harassment report #1182 under review', suspensionCode: 'abuse' }),
  person('u-ken', 'Ken Thompson', 'ken@example.test', { status: 'password-reset-required', passwordResetRequired: true }),
  person('u-hedy', 'Hedy Lamarr', 'hedy@example.test', { emailVerified: false, lastSignInAt: null }),
  person('u-grace', 'Grace Hopper', 'grace@example.test', { role: 'admin', twoFactorEnabled: true }),
];
export const [ada, li, radia, ken, hedy, grace] = users as [AdminUser, AdminUser, AdminUser, AdminUser, AdminUser, AdminUser];

export const entry = (id: string, extra: Partial<AuditEntry>): AuditEntry => ({ id, actorId: 'u-olive', targetId: radia.id, action: 'suspend',
  reason: 'Harassment report #1182 under review', before: { status: 'active' }, after: { status: 'suspended', suspendedUntil: ahead(3) },
  requestId: '6d1f3c1e-3b7a-4f5e-9a51-2f6c0a1d7e11', outcome: 'succeeded', occurredAt: ago(120), reasonCode: 'abuse', userMessage: null,
  actorName: operatorUser.name, actorEmail: operatorUser.email, targetKind: 'user', targetName: radia.name, targetEmail: radia.email, ...extra });
export const auditPage: AuditPage = { nextCursor: null, items: [
  entry('a1', {}),
  entry('a2', { action: 'require-password-reset', targetId: ken.id, targetName: ken.name, targetEmail: ken.email, reasonCode: 'compromised',
    reason: 'Password found in a breach corpus', occurredAt: ago(240) }),
  entry('a3', { action: 'permission_denied', actorId: 'u-margaret', actorName: 'Margaret Hamilton', actorEmail: 'margaret@example.test',
    targetKind: 'other', targetId: '/api/account/admin/users/u-ada/actions', targetName: null, targetEmail: null, reasonCode: null,
    reason: 'Required permission: users:suspend', outcome: 'failed', before: null, after: null, occurredAt: ago(300) }),
  entry('a4', { action: 'client_disabled', targetKind: 'client', targetId: 'notes-app', targetName: 'Notes', targetEmail: null,
    reasonCode: null, reason: 'Leaked client in a public repository', before: { disabled: false }, after: { disabled: true }, occurredAt: ago(60 * 30) }),
] };

export const overview: Overview = {
  suspended: { count: 2, capped: false, users: [{ id: radia.id, name: radia.name, email: radia.email, since: ago(120), until: ahead(3), reasonCode: 'abuse' },
    { id: 'u-bot', name: 'Spam Bot 1', email: 'bot-7731@example.test', since: ago(600), until: null, reasonCode: 'spam' }] },
  passwordResetRequired: { count: 1, capped: false, users: [{ id: ken.id, name: ken.name, email: ken.email, since: ago(240), until: null, reasonCode: 'compromised' }] },
  unverified: { count: 1000, capped: true, users: [{ id: hedy.id, name: hedy.name, email: hedy.email, since: ago(60 * 24 * 7), until: null, reasonCode: null }] },
  failedSignIns: { count: 0, capped: false, users: [] },
  recentActions: auditPage.items.slice(0, 3),
  jobs: [{ id: 'job-1', action: 'suspend', reasonCode: 'spam', total: 12, pending: 4, succeeded: 7, skipped: 1, failed: 0, createdAt: ago(2), finishedAt: null }],
};

export const detail = (user: AdminUser = radia): UserDetail => ({
  profile: user,
  methods: { password: true, passkeys: [{ id: 'pk1', name: 'MacBook Touch ID', createdAt: ago(60 * 24 * 30), backedUp: true, deviceType: 'multiDevice',
      provider: null, lastUsedAt: ago(60 * 24 * 2) }],
    totp: null },
  sessions: { nextCursor: null, items: [{ id: 's1', createdAt: ago(60 * 24), lastActiveAt: ago(30), expiresAt: ahead(6),
    device: { browser: 'Firefox', platform: 'Linux', label: 'Firefox · Linux' }, network: '203.0.113.0/24', thisDevice: false }] },
  apps: { nextCursor: null, items: [{ clientId: 'notes-app', name: 'Notes', uri: null, icon: null, trusted: false,
    scopes: [{ scope: 'work:read', description: { en: 'Read your Works', 'zh-CN': '读取你的作品' } }], grantedAt: ago(60 * 24 * 20),
    lastUsedAt: ago(60 * 3), installationId: 'i1', installationState: 'active' }] },
  activity: { nextCursor: null, failedAttemptsLast24Hours: { count: 2, capped: false }, items: [
    { id: 'e1', action: 'admin_action', detail: { action: 'suspend', requestId: 'r1' }, occurredAt: ago(120) },
    { id: 'e2', action: 'sign_in_failed', detail: { method: 'email' }, occurredAt: ago(200) },
    { id: 'e3', action: 'sign_in', detail: { device: { label: 'Firefox · Linux' }, network: '203.0.113.0/24' }, occurredAt: ago(60 * 24) }] },
  notes: [{ id: 'n1', authorId: 'u-olive', authorName: operatorUser.name, authorEmail: operatorUser.email, createdAt: ago(100),
    body: 'Reporter sent screenshots; waiting for the Realm moderators before lifting.' }],
});

export const operators: Operators = {
  items: [
    { userId: 'u-olive', name: operatorUser.name, email: operatorUser.email, role: 'owner', assignedAt: ago(60 * 24 * 90), status: 'active',
      twoFactorEnabled: true, lastSignInAt: ago(5) },
    { userId: grace.id, name: grace.name, email: grace.email, role: 'admin', assignedAt: ago(60 * 24 * 10), status: 'active',
      twoFactorEnabled: true, lastSignInAt: ago(60 * 5) },
    { userId: 'u-margaret', name: 'Margaret Hamilton', email: 'margaret@example.test', role: 'support', assignedAt: ago(60 * 24 * 2),
      status: 'active', twoFactorEnabled: false, lastSignInAt: null },
  ],
  permissions: { owner: owner.permissions, admin: owner.permissions.filter(permission => permission !== 'operators:manage'),
    support: support.permissions },
};

export const clients: ClientPage = { nextCursor: null, items: [
  { clientId: 'rezics-web', name: 'REZICS', disabled: false, scopes: ['openid', 'offline_access', 'work:read', 'work:create'],
    grantTypes: ['authorization_code', 'refresh_token'], redirectUris: ['https://rezics.test/auth/callback'], userId: null, skipConsent: true,
    type: 'public', uri: 'https://rezics.test', createdAt: ago(60 * 24 * 100),
    installation: { id: 'inst-web', state: 'active', scopes: ['openid', 'offline_access', 'work:read', 'work:create'], installedAt: ago(60 * 24 * 100) } },
  { clientId: 'notes-app', name: 'Notes', disabled: true, scopes: ['openid', 'work:read'], grantTypes: ['authorization_code'],
    redirectUris: ['https://notes.example.test/callback'], userId: null, skipConsent: false, type: 'confidential', uri: null,
    createdAt: ago(60 * 24 * 12), installation: { id: 'inst-notes', state: 'revoked', scopes: ['openid', 'work:read'], installedAt: ago(60 * 24 * 12) } },
] };

export const finishedJob: Job = { id: 'job-2', action: 'suspend', reasonCode: 'spam', reason: 'Coordinated spam wave', actorId: 'u-olive',
  total: 3, pending: 0, succeeded: 1, skipped: 1, failed: 1, createdAt: ago(1), finishedAt: ago(0),
  items: [{ userId: ada.id, name: ada.name, email: ada.email, state: 'succeeded', error: null, requestId: 'r2' },
    { userId: radia.id, name: radia.name, email: radia.email, state: 'skipped', error: null, requestId: null },
    { userId: grace.id, name: grace.name, email: grace.email, state: 'failed', error: 'forbidden', requestId: null }] };

/** An API that answers from the fixtures; a story overrides what it tests. */
export function fakeAdminApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    me: () => ok(owner), overview: () => ok(overview),
    users: params => ok({ items: users.filter(user => !params.q || `${user.name} ${user.email}`.toLowerCase().includes(params.q.toLowerCase())),
      nextCursor: null, exact: users.find(user => user.email === params.q || user.id === params.q) ?? null }),
    user: id => ok(detail(users.find(user => user.id === id) ?? radia)),
    sessions: () => ok({ items: [], nextCursor: null }), apps: () => ok({ items: [], nextCursor: null }),
    activity: () => ok({ items: [], nextCursor: null, failedAttemptsLast24Hours: { count: 0, capped: false } }),
    sanctions: () => ok(auditPage), audit: () => ok(auditPage),
    exportAudit: () => ok({ blob: new Blob(['occurred_at\r\n']), rows: 4, truncated: false }),
    operators: () => ok(operators), clients: () => ok(clients), job: () => ok(finishedJob),
    act: () => ok({ status: true, requestId: '0b8e2d49-6c1c-4c1e-8a2b-8f0a3c7d5e21' }), bulk: () => ok({ jobId: 'job-2' }),
    setRole: () => ok({ status: true, requestId: 'r3' }), setClient: () => ok({ status: true, requestId: 'r4' }),
    changeInstallation: () => ok({ installationId: 'inst-new', clientId: 'notes-app', state: 'active', scopes: ['openid'],
      installedAt: ago(0), revokedAt: null }),
    reauthenticate: () => ok({ verifiedUntil: ahead(0.003) }),
    savePreferences: change => ok({ density: change.density ?? 'comfortable', columns: change.columns ?? null, views: change.views ?? [] }),
    ...overrides,
  };
}

export interface AdminStory { api?: Partial<AdminApi>; me?: AdminMe; section?: AdminSection; density?: 'comfortable' | 'compact';
  client?: Partial<Omit<AdminClient, 'api'>> }

/** Story parameter `admin`: the panel shell with a fake API and spies. */
export const withAdmin: Decorator = (Story, { parameters }) => {
  const admin = (parameters.admin ?? {}) as AdminStory;
  const client: AdminClient = { api: fakeAdminApi(admin.api), navigate: fn(), replaceUrl: fn(), refresh: fn(), download: fn(), ...admin.client };
  return <AdminClientProvider value={client}>
    <AdminShell me={admin.me ?? owner} user={operatorUser} density={admin.density ?? 'comfortable'} section={admin.section}>
      <Story /></AdminShell></AdminClientProvider>;
};

/** Waits for a dialog's opening animation, so visibility checks see it settled. */
export async function settled<T extends Element>(element: T): Promise<T> {
  let layer: Element = element;
  while (layer.parentElement && layer.parentElement !== layer.ownerDocument.body) layer = layer.parentElement;
  const finite = layer.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity);
  await Promise.race([Promise.allSettled(finite.map(animation => animation.finished)), new Promise(resolve => setTimeout(resolve, 2000))]);
  return element;
}
