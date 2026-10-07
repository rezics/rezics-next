import type { Metadata } from 'next';
import { materializeData } from 'native-i18n';
import { redirect } from 'next/navigation';
import { signInPath } from '../../../../features/auth/paths.ts';
import { readSession } from '../../../../features/auth/session.ts';
import { LibraryPage } from '../../../../features/library/library-page.tsx';
import { LoansView } from '../../../../features/library/loans/loans-view.tsx';
import { readLoans } from '../../../../features/library/loans/read.ts';
import { libraryReader, readOverview, type ShelfView } from '../../../../features/library/read.ts';
import { parseLibraryState } from '../../../../features/library/state.ts';
import type { Loaded } from '../../../../features/feed/types.ts';
import { localizedPath } from '../../../../i18n/locale.ts';
import { getMessages, requestLocale } from '../../../../i18n/server.ts';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const emptyShelf = { ok: true, data: { shelf: { kind: 'all' }, custom: null, total: 0, rows: [], nextCursor: null,
  seed: {} } } satisfies Loaded<ShelfView>;

function cursorOf(params: Record<string, string | string[] | undefined>): string | null {
  const raw = params.cursor;
  const cursor = Array.isArray(raw) ? raw[0] : raw;
  return cursor && cursor.length <= 2048 ? cursor : null;
}

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  const t = materializeData(await getMessages('library', locale), { locale });
  return { title: t.loans, description: t.loansDescription, robots: { index: false } };
}

/** The reader's private loans, beside the same shelves as the rest of the library. */
export default async function LibraryLoansRoute({ searchParams }: Props) {
  const [locale, params] = await Promise.all([requestLocale(), searchParams]);
  const cursor = cursorOf(params);
  const here = localizedPath(cursor ? `/library/loans?cursor=${encodeURIComponent(cursor)}` : '/library/loans', locale);
  const session = await readSession();
  if (!session) redirect(signInPath(here));
  if (session.agent.status !== 'selected') redirect(`${localizedPath('/identity', locale)}?next=${encodeURIComponent(here)}`);
  const [reader, overview, loans, messages] = await Promise.all([
    libraryReader(), readOverview(), readLoans(cursor, locale), getMessages('library', locale)]);
  const now = Date.now();
  return <LibraryPage state={parseLibraryState({})} overview={overview} view={emptyShelf} reading={[]} now={now}
    avatarQuery={reader?.avatarQuery} locale={locale} messages={messages}
    loansView={<LoansView items={loans.ok ? loans.data.items : []} nextCursor={loans.ok ? loans.data.nextCursor : null}
      failure={loans.ok ? null : 'unavailable'} cursor={cursor} locale={locale} messages={messages} />} />;
}
