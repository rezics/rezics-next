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

/** One browser and client is one device row, even after repeated sign-ins. */
export function deviceViews(sessions: DeviceSession[], now: Date, locale: AccountLocale): DeviceView[] {
  const groups = new Map<string, DeviceSession[]>();
  for (const session of sessions) {
    const key = session.groupKey ?? `${session.clientName ?? ''}\0${session.browser ?? ''}\0${session.platform ?? ''}`;
    const group = groups.get(key);
    if (group) group.push(session);
    else groups.set(key, [session]);
  }
  return [...groups.values()].map(group => {
    const latest = group.toSorted((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))[0]!;
    return { id: latest.id, ids: group.filter(session => !session.thisDevice).map(session => session.id),
      count: group.length, thisDevice: group.some(session => session.thisDevice),
      clientName: latest.clientName ?? null, browser: latest.browser, platform: latest.platform,
      network: group.length === 1 ? latest.network : null,
      signedIn: relativeTime(latest.createdAt, now, locale),
      lastActive: relativeTime(latest.lastActiveAt, now, locale),
      lastActiveAt: latest.lastActiveAt };
  }).toSorted((a, b) => Number(b.thisDevice) - Number(a.thisDevice)
    || Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
}

function activityViews(entries: ActivityEntry[], now: Date, locale: AccountLocale): ActivityView[] {
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
    trusted: app.trusted, firstParty: app.firstParty === true, withdrawn: app.withdrawn,
    permissionGroups: app.firstParty ? firstPartyPermissionGroups(app.scopes.map(scope => scope.scope)) : [],
    permissions: [...new Set(app.scopes.map(scope => scope.description[
      locale === 'zh-Hans' || locale === 'zh-Hant' ? 'zh-CN' : 'en']))],
    granted: calendarDate(app.grantedAt, locale),
    lastUsed: app.lastUsedAt ? relativeTime(app.lastUsedAt, now, locale) : null }));
}

export type FirstPartyPermissionGroup = 'account' | 'read' | 'create' | 'participate' | 'manage';

/** Every first-party scope has a visible summary; raw descriptions remain available below it. */
export function firstPartyPermissionGroups(scopes: string[]): FirstPartyPermissionGroup[] {
  const groups = new Set<FirstPartyPermissionGroup>();
  for (const scope of scopes) {
    const [subject, action] = scope.split(':');
    if (subject === 'openid' || subject === 'offline_access' || subject === 'notification'
      || subject === 'subscription' || subject === 'export' || subject === 'connected-app') groups.add('account');
    else if (action === 'read' || action === 'select' || subject === 'semantic') groups.add('read');
    else if (['work', 'content', 'source', 'address', 'collection', 'context', 'package', 'theme'].includes(subject!)) groups.add('create');
    else if (['comment', 'rating', 'follow', 'feed', 'event', 'claim', 'realm', 'space',
      'classification', 'judgment', 'statement', 'vote'].includes(subject!)) groups.add('participate');
    else groups.add('manage');
  }
  return (['account', 'read', 'create', 'participate', 'manage'] as const).filter(group => groups.has(group));
}
