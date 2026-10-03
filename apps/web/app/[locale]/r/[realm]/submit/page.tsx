import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PostComposePage } from '../../../../../features/post-composer/page.tsx';
import { postText } from '../../../../../features/post-composer/messages.ts';
import { resolveRealm } from '../../../../../features/realm/read.ts';
import { privateJoinPage } from '../../../../../features/realm/realm-page.tsx';
import { realmMetadata } from '../../../../../features/realm/routes.tsx';
import { RealmUnavailable } from '../../../../../features/realm/states.tsx';
import { spaceHref } from '../../../../../features/address/path.ts';
import { getMessages } from '../../../../../i18n/server.ts';
import { requestLocale } from '../../../../../i18n/server.ts';

type Props = { params: Promise<{ realm: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [locale, { realm }] = await Promise.all([requestLocale(), params]);
  const [selected, metadata] = await Promise.all([
    resolveRealm(realm, locale),
    realmMetadata({ params: Promise.resolve({ locale, realm }) }, 'discussions'),
  ]);
  return { ...metadata, ...(selected.kind === 'realm' ? { title: postText.title[locale] } : {}) };
}

export default async function Page({ params }: Props) {
  const [locale, { realm }] = await Promise.all([requestLocale(), params]);
  const selected = await resolveRealm(realm, locale);
  if (selected.kind === 'missing') notFound();
  if (selected.kind === 'join')
    return privateJoinPage(selected.page, locale, spaceHref(realm, 'community', ['submit']));
  if (selected.kind === 'unavailable')
    return <RealmUnavailable messages={await getMessages('realm', locale)} />;
  return (
    <PostComposePage
      locale={locale}
      initial={{ id: selected.header.id, name: selected.header.name.value }}
    />
  );
}
