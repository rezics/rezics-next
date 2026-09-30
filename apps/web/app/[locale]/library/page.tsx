import type { Metadata } from 'next';
import { materializeData } from 'native-i18n';
import { redirect } from 'next/navigation';
import { signInPath } from '../../../features/auth/paths.ts';
import { readSession } from '../../../features/auth/session.ts';
import { LibraryPage } from '../../../features/library/library-page.tsx';
import { libraryReader, readCurrentlyReading, readFollowedAuthors, readOverview, readShelfView,
  readReadingYear, readYearlyGoal }
  from '../../../features/library/read.ts';
import { libraryHref, parseLibraryState } from '../../../features/library/state.ts';
import { localizedPath } from '../../../i18n/locale.ts';
import { getMessages, requestLocale } from '../../../i18n/server.ts';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  const t = materializeData(await getMessages('library', locale), { locale });
  return { title: t.title, description: t.description, robots: { index: false } };
}

/**
 * The reader's library. Signed out it asks for sign-in first; without a
 * chosen Agent, which Agent's library; then it reads as that Agent.
 */
export default async function LibraryRoute({ searchParams }: Props) {
  const [locale, params] = await Promise.all([requestLocale(), searchParams]);
  const state = parseLibraryState(params);
  const here = localizedPath(libraryHref(state), locale);
  const session = await readSession();
  if (!session) redirect(signInPath(here));
  if (session.agent.status !== 'selected') redirect(`${localizedPath('/identity', locale)}?next=${encodeURIComponent(here)}`);
  const first = state.shelf.kind === 'all' && state.cursor === null;
  const year = new Date().getUTCFullYear();
  const [reader, overview, view, reading, authors, goal, stats, messages] = await Promise.all([
    libraryReader(), readOverview(),
    readShelfView(state, locale), first ? readCurrentlyReading(locale) : [], first ? readFollowedAuthors(locale) : null,
    readYearlyGoal(year), readReadingYear(year), getMessages('library', locale)]);
  return <LibraryPage state={state} overview={overview} view={view} reading={reading} authors={authors} now={Date.now()}
    goal={goal} stats={stats} avatarQuery={reader?.avatarQuery} locale={locale} messages={messages} />;
}
