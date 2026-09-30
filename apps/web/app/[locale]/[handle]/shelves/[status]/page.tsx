import type { Metadata } from 'next';
import { materializeData } from 'native-i18n';
import { notFound, permanentRedirect } from 'next/navigation';
import { ProfileShelfPage, ProfileUnavailable, shelfLabel } from '../../../../../features/profile/profile-page.tsx';
import { profileReader, readReaderState, readShelfPage, resolveProfile }
  from '../../../../../features/profile/read.ts';
import { parseCursor, parseHandleSegment, parseShelfStatus, profileHref }
  from '../../../../../features/profile/route.ts';
import { localizedPath } from '../../../../../i18n/locale.ts';
import { getMessages, requestLocale } from '../../../../../i18n/server.ts';

type Props = { params: Promise<{ handle: string; status: string }>;
  searchParams: Promise<{ cursor?: string | string[] }> };

const PAGE = 20;

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const path = await params;
  const handle = parseHandleSegment(path.handle);
  const status = parseShelfStatus(path.status);
  if (!handle || !status) return {};
  const locale = await requestLocale();
  const [resolved, messages] = await Promise.all([resolveProfile(handle, locale), getMessages('profile', locale)]);
  if (resolved.kind !== 'profile') return {};
  const t = materializeData(messages, { locale });
  return { title: t.pageTitle({ title: shelfLabel(status, t), name: resolved.profile.displayName }),
    ...(parseCursor((await searchParams).cursor) ? { robots: { index: false } } : {}) };
}

/** One status shelf in full. A shelf the reader may not see is a 404, as Main answers it. */
export default async function ProfileShelfRoute({ params, searchParams }: Props) {
  const path = await params;
  const handle = parseHandleSegment(path.handle);
  const status = parseShelfStatus(path.status);
  if (!handle || !status) notFound();
  const [locale, query] = await Promise.all([requestLocale(), searchParams]);
  const cursor = parseCursor(query.cursor);
  const [resolved, messages] = await Promise.all([resolveProfile(handle, locale), getMessages('profile', locale)]);
  if (resolved.kind === 'missing') notFound();
  if (resolved.kind === 'moved') {
    permanentRedirect(localizedPath(profileHref(resolved.handle, { kind: 'shelf', status }, cursor), locale));
  }
  if (resolved.kind === 'unavailable') return <ProfileUnavailable handle={handle} locale={locale} messages={messages} />;
  const { profile } = resolved;
  if (profile.kind !== 'person' || !profile.library.statusShelvesVisible) notFound();
  const [shelf, reader] = await Promise.all([readShelfPage(profile, status, PAGE, cursor), profileReader()]);
  if (!shelf.ok && shelf.failure === 'missing') notFound();
  const seed = await readReaderState(shelf.ok ? shelf.data.cards.map(card => card.id) : []);
  return <ProfileShelfPage profile={profile} status={status} shelf={shelf} cursor={cursor}
    reader={{ signedIn: reader.signedIn, actingSubject: reader.actingSubject, avatarQuery: reader.avatarQuery, seed }}
    locale={locale} messages={messages} />;
}
