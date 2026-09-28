import type { Metadata } from 'next';
import { CommunityDirectory } from '../../../features/communities/directory.tsx';
import { communityText } from '../../../features/communities/messages.ts';
import { requestLocale } from '../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: communityText.title[await requestLocale()] };
}

export default async function Page({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [locale, search] = await Promise.all([requestLocale(), searchParams]);
  return <CommunityDirectory locale={locale} search={search} />;
}
