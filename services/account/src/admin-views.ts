import { t } from 'elysia';
import { literalUnion } from './http.ts';
import { activityView, auditView, clientView, connectedAppView, methodsView, noteView, operatorRoleView,
  pageView, profileView, sessionView } from './views.ts';

// Response shapes of the operator panel. The Accounts site derives its types
// from these routes (`AccountApp`), so a field added here reaches the panel's
// type-check before it reaches a page.

export const directoryColumns = ['name', 'email', 'status', 'role', 'verified', 'twoFactor', 'created',
  'lastSignIn'] as const;
const nullableString = t.Nullable(t.String());
export const adminProfileView = t.Object({ ...profileView.properties, role: t.Nullable(operatorRoleView),
  suspendedAt: nullableString, suspensionCode: nullableString, lastSignInAt: nullableString });
export const directoryView = t.Object({ ...pageView(adminProfileView).properties,
  /** The user whose ID or email is exactly the search text, wherever it sorts. */
  exact: t.Nullable(adminProfileView) });
export const adminNoteView = t.Object({ ...noteView.properties, authorName: nullableString, authorEmail: nullableString });
export const adminUserDetailView = t.Object({ profile: adminProfileView, methods: methodsView,
  sessions: pageView(sessionView), apps: pageView(connectedAppView), activity: activityView,
  notes: t.Array(adminNoteView) });
export const auditEntryView = t.Object({ ...auditView.properties, reasonCode: nullableString,
  userMessage: nullableString, actorName: nullableString, actorEmail: nullableString,
  targetKind: t.Union([t.Literal('user'), t.Literal('client'), t.Literal('other')]),
  targetName: nullableString, targetEmail: nullableString });
const cappedCount = t.Object({ count: t.Integer(), capped: t.Boolean() });
const queueUser = t.Object({ id: t.String(), name: t.String(), email: t.String(), since: t.String(),
  until: nullableString, reasonCode: nullableString, count: t.Optional(t.Integer()) });
export const jobSummaryView = t.Object({ id: t.String(), action: t.String(), reasonCode: t.String(),
  total: t.Integer(), pending: t.Integer(), succeeded: t.Integer(), skipped: t.Integer(), failed: t.Integer(),
  createdAt: t.String(), finishedAt: nullableString });
export const overviewView = t.Object({
  suspended: t.Object({ ...cappedCount.properties, users: t.Array(queueUser) }),
  passwordResetRequired: t.Object({ ...cappedCount.properties, users: t.Array(queueUser) }),
  unverified: t.Object({ ...cappedCount.properties, users: t.Array(queueUser) }),
  failedSignIns: t.Object({ ...cappedCount.properties, users: t.Array(queueUser) }),
  recentActions: t.Nullable(t.Array(auditEntryView)), jobs: t.Array(jobSummaryView) });
export const jobView = t.Object({ ...jobSummaryView.properties, reason: t.String(), actorId: t.String(),
  items: t.Array(t.Object({ userId: t.String(), name: nullableString, email: nullableString,
    state: t.Union([t.Literal('pending'), t.Literal('succeeded'), t.Literal('skipped'), t.Literal('failed')]),
    error: nullableString, requestId: nullableString })) });
export const operatorEntryView = t.Object({ userId: t.String(), name: t.String(), email: t.String(),
  role: operatorRoleView, assignedAt: t.String(), status: profileView.properties.status,
  twoFactorEnabled: t.Boolean(), lastSignInAt: nullableString });
export const operatorsView = t.Object({ items: t.Array(operatorEntryView),
  permissions: t.Object({ owner: t.Array(t.String()), admin: t.Array(t.String()), support: t.Array(t.String()) }) });
export const savedView = t.Object({ id: t.String({ pattern: '^[a-z0-9-]{1,40}$' }),
  name: t.String({ minLength: 1, maxLength: 60 }), query: t.String({ maxLength: 1000 }) });
export const directoryColumn = literalUnion(directoryColumns);
export const preferencesView = t.Object({ density: t.Union([t.Literal('comfortable'), t.Literal('compact')]),
  columns: t.Nullable(t.Array(directoryColumn)), views: t.Array(savedView) });
export const adminClientView = t.Object({ ...clientView.properties, type: t.Union([t.Literal('public'), t.Literal('confidential')]),
  uri: nullableString, createdAt: nullableString, installation: t.Nullable(t.Object({ id: t.String(),
    state: t.String(), scopes: t.Array(t.String()), installedAt: t.String() })) });
