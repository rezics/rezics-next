import { t } from 'elysia';
import { accountErrorSchema } from './http.ts';

export const pageView = <S extends ReturnType<typeof t.Object>>(item: S) =>
  t.Object({ items: t.Array(item), nextCursor: t.Nullable(t.String()) });
export const statusView = t.Object({ status: t.Boolean() });
export const commandView = t.Object({ status: t.Boolean(), requestId: t.String() });
export const descriptionView = t.Object({ scope: t.String(), description: t.Object({
  en: t.String(), 'zh-Hant': t.String(), 'zh-Hans': t.String(), ja: t.String(),
  ko: t.String(), de: t.String(), fr: t.String(), es: t.String() }) });
export const consentView = t.Object({ client: t.Object({ id: t.String(), name: t.String(),
  uri: t.Nullable(t.String()), icon: t.Nullable(t.String()) }), scopes: t.Array(descriptionView),
resources: t.Array(t.String()), expiresAt: t.String() });
export const consentDecisionView = t.Object({ redirect: t.Boolean(), url: t.String() });
export const methodsView = t.Object({ password: t.Boolean(), passwordChangedAt: t.Nullable(t.String()),
  passkeys: t.Array(t.Object({
    id: t.String(), name: t.Nullable(t.String()), createdAt: t.String(), backedUp: t.Boolean(), deviceType: t.String(),
    provider: t.Nullable(t.String()), lastUsedAt: t.Nullable(t.String()),
  })), totp: t.Nullable(t.Object({ id: t.String(), name: t.String(), verified: t.Boolean() })) });
export const sessionView = t.Object({ id: t.String(), createdAt: t.String(), lastActiveAt: t.String(), expiresAt: t.String(),
  device: t.Object({ browser: t.String(), platform: t.Nullable(t.String()), label: t.String() }),
  network: t.Nullable(t.String()), thisDevice: t.Boolean(), clientName: t.Optional(t.Nullable(t.String())),
  groupKey: t.Optional(t.String()) });
export const eventView = t.Object({ id: t.String(), action: t.String(), detail: t.Record(t.String(), t.Unknown()), occurredAt: t.String() });
export const activityView = t.Object({ ...pageView(eventView).properties,
  failedAttemptsLast24Hours: t.Object({ count: t.Integer(), capped: t.Boolean() }) });
export const connectedAppView = t.Object({ clientId: t.String(), name: t.String(), uri: t.Nullable(t.String()),
  icon: t.Nullable(t.String()), trusted: t.Boolean(), firstParty: t.Optional(t.Boolean()), scopes: t.Array(descriptionView), grantedAt: t.String(),
  lastUsedAt: t.Nullable(t.String()), installationId: t.Nullable(t.String()), installationState: t.Nullable(t.String()) });
export const profileView = t.Object({ id: t.String(), name: t.String(), email: t.String(), image: t.Nullable(t.String()),
  emailVerified: t.Boolean(), twoFactorEnabled: t.Boolean(), createdAt: t.String(), updatedAt: t.String(),
  passwordResetRequired: t.Boolean(), suspendedUntil: t.Nullable(t.String()), suspensionReason: t.Nullable(t.String()),
  status: t.Union([t.Literal('active'), t.Literal('suspended'), t.Literal('password-reset-required')]) });
export const noteView = t.Object({ id: t.String(), authorId: t.String(), body: t.String(), createdAt: t.String() });
export const operatorRoleView = t.Union([t.Literal('owner'), t.Literal('admin'), t.Literal('support')]);
export const userDetailView = t.Object({ profile: profileView, methods: methodsView,
  sessions: pageView(sessionView), apps: pageView(connectedAppView), activity: activityView,
  notes: t.Array(noteView) });
export const auditView = t.Object({ id: t.String(), actorId: t.String(), targetId: t.String(), action: t.String(),
  reason: t.String(), before: t.Unknown(), after: t.Unknown(), requestId: t.String(), outcome: t.String(), occurredAt: t.String() });
export const clientView = t.Object({ clientId: t.String(), name: t.Nullable(t.String()), disabled: t.Nullable(t.Boolean()),
  scopes: t.Nullable(t.Array(t.String())), grantTypes: t.Nullable(t.Array(t.String())), redirectUris: t.Array(t.String()),
  userId: t.Nullable(t.String()), skipConsent: t.Nullable(t.Boolean()), firstParty: t.Boolean() });

/** A capped list; `truncated` says older rows exist beyond the cap. */
const cappedList = <S extends ReturnType<typeof t.Object>>(item: S) =>
  t.Object({ items: t.Array(item), truncated: t.Boolean() });
/** "Download your data": what Account keeps about the person, without
 * credential material (password hashes, passkey keys, TOTP secrets, tokens). */
export const accountExportView = t.Object({ format: t.Literal('rezics-account-export/1'), exportedAt: t.String(),
  account: t.Object({ id: t.String(), name: t.String(), email: t.String(), emailVerified: t.Boolean(),
    image: t.Nullable(t.String()), locale: t.Nullable(t.String()), createdAt: t.String(), updatedAt: t.String() }),
  displayPreferences: t.Object({ displayMode: t.String(), showZoneThemes: t.Boolean() }),
  signInMethods: methodsView,
  devices: cappedList(sessionView),
  connectedApps: cappedList(connectedAppView),
  securityActivity: cappedList(eventView) });

export const accountResponses =<S extends ReturnType<typeof t.Object>>(success: S) => ({
  200: success, 400: accountErrorSchema, 401: accountErrorSchema, 403: accountErrorSchema,
  404: accountErrorSchema, 409: accountErrorSchema, 429: accountErrorSchema, 503: accountErrorSchema,
});
