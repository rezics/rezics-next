import type { Metadata } from 'next';
import { materializeData } from 'native-i18n';
import { notFound, permanentRedirect } from 'next/navigation';
import { ProfileUnavailable, ProfileWorksPage } from '../../../../features/profile/profile-page.tsx';
import { profileReader, readProfileWorks, readReaderState, resolveProfile }
  from '../../../../features/profile/read.ts';
import { parseCursor, parseHandleSegment, profileHref } from '../../../../features/profile/route.ts';
import { localizedPath } from '../../../../i18n/locale.ts';
import { getMessages, requestLocale } from '../../../../i18n/server.ts';

type Props = { params: Promise<{ handle: string }>; searchParams: Promise<{ cursor?: string | string[] }> };

const PAGE = 20;

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const handle = parseHandleSegment((await params).handle);
  if (!handle) return {};
  const locale = await requestLocale();
  const [resolved, messages] = await Promise.all([resolveProfile(handle, locale), getMessages('profile', locale)]);
  if (resolved.kind !== 'profile') return { robots: { index: false } };
  const t = materializeData(messages, { locale });
  // Later pages repeat the first page's subject; only the first is a document to index.
  return { title: t.worksHeading({ name: resolved.profile.displayName }),
    ...(parseCursor((await searchParams).cursor) ? { robots: { index: false } } : {}) };
}

export default async function ProfileWorksRoute({ params, searchParams }: Props) {
  const handle = parseHandleSegment((await params).handle);
  if (!handle) notFound();
  const [locale, query] = await Promise.all([requestLocale(), searchParams]);
  const cursor = parseCursor(query.cursor);
  const [resolved, messages] = await Promise.all([resolveProfile(handle, locale), getMessages('profile', locale)]);
  if (resolved.kind === 'missing') notFound();
  if (resolved.kind === 'moved') {
    permanentRedirect(localizedPath(profileHref(resolved.handle, { kind: 'works' }, cursor), locale));
  }
  if (resolved.kind === 'unavailable') return <ProfileUnavailable handle={handle} locale={locale} messages={messages} />;
  const [works, reader] = await Promise.all([readProfileWorks(resolved.profile.id, locale, PAGE, cursor),
    profileReader()]);
  const seed = await readReaderState(works.ok ? works.data.items.map(item => item.id) : []);
  return <ProfileWorksPage profile={resolved.profile} works={works} cursor={cursor}
    reader={{ signedIn: reader.signedIn, actingSubject: reader.actingSubject, avatarQuery: reader.avatarQuery, seed }}
    locale={locale} messages={messages} />;
}
