import type { Metadata } from 'next';
import { PostComposePage } from '../../../features/post-composer/page.tsx';
import { postText } from '../../../features/post-composer/messages.ts';
import { requestLocale } from '../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: postText.title[await requestLocale()] };
}

export default async function Page() {
  return <PostComposePage locale={await requestLocale()} />;
}
