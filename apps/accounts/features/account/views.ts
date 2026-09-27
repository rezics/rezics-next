// Server-side view models: dates are localized once on the server so the
// hydrated page shows the same text.
import { type ActivityEntry, presentActivity } from './activity.ts';
import type { ActivityView } from './activity-list.tsx';
import type { ConnectedAppView } from './connected-apps.tsx';
import type { DeviceView } from './devices.tsx';
import type { PasskeyView } from './passkeys.tsx';
import { calendarDate, relativeTime } from './format.ts';
import type { AccountLocale, ConnectedApp, DeviceSession, Passkey, SecurityActivity } from '../api/account-data.ts';

export function passkeyViews(passkeys: Passkey[], now: Date, locale: AccountLocale): PasskeyView[] {
  return passkeys.map(passkey => ({ id: passkey.id, name: passkey.name, provider: passkey.provider,
    synced: passkey.backedUp, created: calendarDate(passkey.createdAt, locale),
    lastUsed: passkey.lastUsedAt ? relativeTime(passkey.lastUsedAt, now, locale) : null }));
}

/** This device first, then the rest by last activity. */
export function deviceViews(sessions: DeviceSession[], now: Date, locale: AccountLocale): DeviceView[] {
  return sessions.toSorted((a, b) => Number(b.thisDevice) - Number(a.thisDevice)
    || Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))
    .map(session => ({ id: session.id, thisDevice: session.thisDevice, browser: session.browser,
      platform: session.platform, network: session.network, signedIn: relativeTime(session.createdAt, now, locale),
      lastActive: relativeTime(session.lastActiveAt, now, locale) }));
}

export function activityViews(entries: ActivityEntry[], now: Date, locale: AccountLocale): ActivityView[] {
  return entries.map(entry => ({ ...entry, when: relativeTime(entry.occurredAt, now, locale) }));
}

/** One page of the 90-day activity feed, with the cursor to older events while any may remain. */
export function activityPage(activity: SecurityActivity, now: Date, locale: AccountLocale) {
  const { entries, complete } = presentActivity(activity.items, now, !!activity.nextCursor);
  return { entries: activityViews(entries, now, locale), older: complete ? null : activity.nextCursor };
}

/** Connected Apps' names by client ID, for naming them in security activity. */
export function appNames(apps: { status: string; data?: { items: ConnectedApp[] } }): Record<string, string> {
  return Object.fromEntries(apps.status === 'ok' ? apps.data!.items.map(app => [app.clientId, app.name]) : []);
}

export function connectedAppViews(apps: ConnectedApp[], now: Date, locale: AccountLocale): ConnectedAppView[] {
  return apps.map(app => ({ clientId: app.clientId, name: app.name, uri: app.uri, icon: app.icon,
    trusted: app.trusted, withdrawn: app.withdrawn,
    permissions: [...new Set(app.scopes.map(scope => scope.description[locale]))],
    granted: calendarDate(app.grantedAt, locale),
    lastUsed: app.lastUsedAt ? relativeTime(app.lastUsedAt, now, locale) : null }));
}
