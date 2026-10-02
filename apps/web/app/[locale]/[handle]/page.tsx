import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { profileJsonLd, profileMetadata } from '../../../features/profile/metadata.ts';
import { ProfilePage, ProfileUnavailable } from '../../../features/profile/profile-page.tsx';
import { profileReader, readFollowState, readLibrary, readProfileWorks, readReaderState, resolveProfile }
  from '../../../features/profile/read.ts';
import { parseHandleSegment, profileHref } from '../../../features/profile/route.ts';
import { localizedPath } from '../../../i18n/locale.ts';
import { getMessages, requestLocale } from '../../../i18n/server.ts';

type Props = { params: Promise<{ handle: string }> };

// Goodreads lists ten of an author's books before "More books by …"; each shelf row shows a dozen covers.
const OVERVIEW_WORKS = 10;
const SHELF_PREVIEW = 12;

// Metadata reads the profile directly and never throws notFound(): vinext
// streams metadata, so a 404 thrown there would answer 200. The page does.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const handle = parseHandleSegment((await params).handle);
  if (!handle) return {};
  const locale = await requestLocale();
  const [resolved, messages] = await Promise.all([resolveProfile(handle, locale), getMessages('profile', locale)]);
  if (resolved.kind !== 'profile') return { robots: { index: false } };
  const works = await readProfileWorks(resolved.profile.id, locale, OVERVIEW_WORKS);
  return profileMetadata(resolved.profile, works.ok && works.data.items.length > 0, locale, messages);
}

/**
 * `/@{handle}` for every Agent kind. Any other single segment under a locale
 * lands here too (see `features/profile/route.ts`) and is a 404. A retired,
 * native or differently cased handle moves to the current one with a
 * permanent redirect: a retired name stays with its Agent and cannot be
 * claimed by someone else.
 */
export default async function ProfileRoute({ params }: Props) {
  const handle = parseHandleSegment((await params).handle);
  if (!handle) notFound();
  const locale = await requestLocale();
  const [resolved, messages] = await Promise.all([resolveProfile(handle, locale), getMessages('profile', locale)]);
  if (resolved.kind === 'missing') notFound();
  if (resolved.kind === 'moved') permanentRedirect(localizedPath(profileHref(resolved.handle), locale));
  if (resolved.kind === 'unavailable') return <ProfileUnavailable handle={handle} locale={locale} messages={messages} />;
  const { profile } = resolved;
  const [works, follow, library, reader] = await Promise.all([
    readProfileWorks(profile.id, locale, OVERVIEW_WORKS),
    readFollowState(profile.id, locale),
    profile.kind === 'person' ? readLibrary(profile, SHELF_PREVIEW) : null,
    profileReader(),
  ]);
  const seed = await readReaderState([...works.ok ? works.data.items.map(item => item.id) : [],
    ...library?.kind === 'shelves' ? library.shelves.flatMap(shelf => shelf.works.ok
      ? shelf.works.data.map(card => card.id) : []) : []]);
  return <>
    {/* JSON-LD must be raw script text; profileJsonLd escapes `<` so it cannot close the element. */}
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: profileJsonLd(profile,
      follow.ok && follow.data.followers.kind === 'exact' ? follow.data.followers.value : null) }} />
    <ProfilePage profile={profile} works={works} follow={follow} library={library}
      reader={{ signedIn: reader.signedIn, actingSubject: reader.actingSubject, avatarQuery: reader.avatarQuery, seed }}
      locale={locale} messages={messages} />
  </>;
}
