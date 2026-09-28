import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PostComposePage } from '../../../../../features/post-composer/page.tsx';
import { postText } from '../../../../../features/post-composer/messages.ts';
import { resolveRealm } from '../../../../../features/realm/read.ts';
import { requestLocale } from '../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: postText.title[await requestLocale()] };
}

export default async function Page({ params }: { params: Promise<{ realm: string }> }) {
  const [locale, { realm }] = await Promise.all([requestLocale(), params]);
  const selected = await resolveRealm(realm, locale);
  if (selected.kind === 'missing') notFound();
  return <PostComposePage locale={locale} initial={selected.kind === 'realm'
    ? { id: selected.header.id, name: selected.header.name.value } : null} />;
}
