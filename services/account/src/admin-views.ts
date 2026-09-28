import { t } from 'elysia';
import { literalUnion } from './http.ts';
import { signalKinds, type SignalKind } from './admin-signals.ts';
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

const subjectView = t.Union([
  t.Object({ kind: t.Literal('user'), id: t.String(), name: t.String(), email: t.String() }),
  t.Object({ kind: t.Literal('client'), id: t.String(), name: t.String(), email: t.Null() }),
]);
const signalBase = { key: t.String(), severity: t.Union([t.Literal('high'), t.Literal('medium')]), occurredAt: t.String(),
  subject: subjectView };
/** A pattern worth a look, with the evidence that raised it. */
export const signalView = t.Union([
  t.Object({ ...signalBase, kind: t.Literal('failed-sign-ins'), evidence: t.Object({ failures: t.Integer(), firstAt: t.String(),
    lastAt: t.String(), signedInAfter: t.Boolean() }) }),
  t.Object({ ...signalBase, kind: t.Literal('email-after-password'), evidence: t.Object({ emailChangedAt: t.String(),
    passwordChangedAt: t.String() }) }),
  t.Object({ ...signalBase, kind: t.Literal('new-passkey'), evidence: t.Object({ addedAt: t.String(), accountCreatedAt: t.String() }) }),
  t.Object({ ...signalBase, kind: t.Literal('mass-consent'), evidence: t.Object({ accounts: t.Integer(), dailyAverage: t.Number(),
    firstAt: t.String(), lastAt: t.String() }) }),
]);
const cappedCount = t.Object({ count: t.Integer(), capped: t.Boolean() });
export const signalsView = t.Object({ items: t.Array(signalView),
  counts: t.Object(Object.fromEntries(signalKinds.map(kind => [kind, cappedCount])) as Record<SignalKind, typeof cappedCount>),
  reviewedLastDay: t.Integer() });

/** One line of an account's story: a security event, a staff action (with
 * who and why) or a staff note. */
export const timelineEntryView = t.Object({ id: t.String(), source: t.Union([t.Literal('security'), t.Literal('staff'), t.Literal('note')]),
  action: t.String(), detail: t.Record(t.String(), t.Unknown()), occurredAt: t.String(),
  staff: t.Nullable(t.Object({ actorId: t.String(), actorName: nullableString, actorEmail: nullableString, reason: t.String(),
    reasonCode: nullableString, userMessage: nullableString, outcome: t.String(), requestId: t.String(), before: t.Unknown(),
    after: t.Unknown() })),
  note: t.Nullable(t.Object({ body: t.String(), authorId: t.String(), authorName: nullableString, authorEmail: nullableString })) });
export const timelineView = pageView(timelineEntryView);

export const adminUserDetailView = t.Object({ profile: adminProfileView, methods: methodsView,
  sessions: pageView(sessionView), apps: pageView(connectedAppView), activity: activityView,
  notes: t.Array(adminNoteView), timeline: timelineView, signals: t.Array(signalView) });
export const auditEntryView = t.Object({ ...auditView.properties, reasonCode: nullableString,
  userMessage: nullableString, actorName: nullableString, actorEmail: nullableString,
  targetKind: t.Union([t.Literal('user'), t.Literal('client'), t.Literal('other')]),
  targetName: nullableString, targetEmail: nullableString });
const queueUser = t.Object({ id: t.String(), name: t.String(), email: t.String(), since: t.String(),
  until: nullableString, reasonCode: nullableString });
/** `startsAt` ends the undo window; `cancelledAt` marks a job its operator stopped. */
export const jobSummaryView = t.Object({ id: t.String(), action: t.String(), reasonCode: t.String(),
  total: t.Integer(), pending: t.Integer(), succeeded: t.Integer(), skipped: t.Integer(), failed: t.Integer(),
  cancelled: t.Integer(), createdAt: t.String(), startsAt: t.String(), finishedAt: nullableString, cancelledAt: nullableString });
export const overviewView = t.Object({
  signals: signalsView,
  suspended: t.Object({ ...cappedCount.properties, users: t.Array(queueUser) }),
  passwordResetRequired: t.Object({ ...cappedCount.properties, users: t.Array(queueUser) }),
  unverified: t.Object({ ...cappedCount.properties, users: t.Array(queueUser) }),
  recentActions: t.Nullable(t.Array(auditEntryView)), jobs: t.Array(jobSummaryView) });
export const jobView = t.Object({ ...jobSummaryView.properties, reason: t.String(), actorId: t.String(),
  items: t.Array(t.Object({ userId: t.String(), name: nullableString, email: nullableString,
    state: t.Union([t.Literal('pending'), t.Literal('succeeded'), t.Literal('skipped'), t.Literal('failed'), t.Literal('cancelled')]),
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
