import type { Metadata } from 'next';
import { mainApi } from '../../../features/api/main.ts';
import { signInPath } from '../../../features/auth/paths.ts';
import { readSession } from '../../../features/auth/session.ts';
import { readOfficialZones, shellReader } from '../../../features/shell/communities-read.ts';
import { RealmInvitations } from '../../../features/shell/notifications/invitations.tsx';
import { readInvitations } from '../../../features/shell/notifications/invitations-read.ts';
import { NotificationsUnavailable, NotificationsView }
  from '../../../features/shell/notifications/notifications-view.tsx';
import { parseSelection, readLatest } from '../../../features/shell/notifications/window.ts';
import { isUiLocale } from '../../../i18n/define.ts';
import { localizedPath } from '../../../i18n/locale.ts';
import { getTranslation } from '../../../i18n/server.ts';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!isUiLocale(locale)) return {};
  const { data } = await getTranslation('shell', [locale]);
  return { title: data.notifications, robots: { index: false } };
}

export default async function NotificationsPage({ params, searchParams }: { params: Promise<{ locale: string }>;
  searchParams: Promise<{ view?: string | string[]; reason?: string | string[] }> }) {
  const [{ locale: requested }, search] = await Promise.all([params, searchParams]);
  const locale = isUiLocale(requested) ? requested : 'en';
  const selection = parseSelection({
    view: typeof search.view === 'string' ? search.view : undefined,
    reason: typeof search.reason === 'string' ? search.reason : undefined });
  const signInHref = signInPath(localizedPath('/notifications', locale));
  if (!await readSession()) return <NotificationsUnavailable reason="signed-out" signInHref={signInHref} />;
  // Notifications belong to the person, not an Agent, so they read with the session's token alone.
  // Invitations are to an Agent, so they read as the session's Agent.
  const [latest, reader, official] = await Promise.all([readLatest(await mainApi(), selection), shellReader(),
    readOfficialZones(locale)]);
  if (!latest.ok) return <NotificationsUnavailable reason="failed" failure={latest.failure} reference={latest.reference}
    signInHref={signInHref} />;
  const invitations = reader.actingSubject
    ? await readInvitations(reader.main, reader.anonymous, reader.actingSubject, locale, official) : [];
  return <NotificationsView key={`${selection.view}:${selection.reason ?? ''}`} initial={latest.data} now={Date.now()}
    avatarQuery={reader.avatarQuery} actingSubject={reader.actingSubject ?? undefined} selection={selection}
    invitations={reader.actingSubject && invitations.length
      ? <RealmInvitations invitations={invitations} actingSubject={reader.actingSubject} /> : null} />;
}
