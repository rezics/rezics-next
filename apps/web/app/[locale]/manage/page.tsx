import type { Metadata } from 'next';
import { localizedPath } from '../../../i18n/locale.ts';
import { ManageHome } from '../../../features/manage/manage-home.tsx';
import { readManagedRealms, readRealmHeader } from '../../../features/manage/read.ts';
import { manager } from '../../../features/manage/server.ts';
import { type Loaded, uuidOf } from '../../../features/manage/types.ts';
import type { ManagedList } from '../../../features/manage/manage-home.tsx';
import { readOfficialZones } from '../../../features/shell/communities-read.ts';
import { realmSegment } from '../../../features/shell/communities.ts';
import { getMessages, getTranslation, requestLocale } from '../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('manage', [await requestLocale()]);
  return { title: t.title, robots: { index: false } };
}

export default async function ManageRoute({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [locale, params] = await Promise.all([requestLocale(), searchParams]);
  // Main's cursor is the last Realm's IRI.
  const after = typeof params.after === 'string' && /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(params.after)
    ? params.after : null;
  const path = after ? `/manage?${new URLSearchParams({ after })}` : '/manage';
  const { agent, actingSubject, main, anonymous, signInHref } = await manager(locale, path);
  const [messages, page, official] = await Promise.all([getMessages('manage', locale),
    readManagedRealms(main, actingSubject, after), readOfficialZones(locale)]);
  const realms: Loaded<ManagedList> = !page.ok ? page : { ok: true, data: { nextCursor: page.data.nextCursor,
    items: await Promise.all(page.data.items.map(async realm => {
      const header = await readRealmHeader(anonymous, uuidOf(realm.realm), locale);
      return { realm, header: header.ok ? header.data : null, address: realmSegment(realm.realm, official) };
    })) } };
  const next = page.ok ? page.data.nextCursor : null;
  return <ManageHome agent={agent} realms={realms} now={Date.now()} locale={locale} messages={messages}
    moreHref={next ? `/manage?${new URLSearchParams({ after: next })}` : null} signInHref={signInHref}
    retryHref={localizedPath(path, locale)} />;
}
