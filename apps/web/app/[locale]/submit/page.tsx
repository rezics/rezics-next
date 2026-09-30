import type { Metadata } from 'next';
import { readEntityProjection } from '../../../features/entity-page/read.ts';
import { parseEntityRef } from '../../../features/entity-page/route.ts';
import { iriOf } from '../../../features/work-page/route.ts';
import type { WorkChoice } from '../../../features/post-composer/composer.tsx';
import { PostComposePage } from '../../../features/post-composer/page.tsx';
import { postText } from '../../../features/post-composer/messages.ts';
import { requestLocale } from '../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: postText.title[await requestLocale()] };
}

/** `?target={id}`: a page's "Discuss this" names the resource to post about, which its projection roots. */
async function targetOf(ref: string | string[] | undefined): Promise<WorkChoice | null> {
  const id = typeof ref === 'string' ? parseEntityRef(ref) : null;
  if (!id) return null;
  const page = await readEntityProjection(id);
  if (!page.ok || page.data.summary.status !== 'available') return null;
  return { id: iriOf(id), mainVersion: null, revision: page.data.target.revision, title: page.data.summary.name.value };
}

export default async function Page({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [locale, query] = await Promise.all([requestLocale(), searchParams]);
  return <PostComposePage locale={locale} target={await targetOf(query.target)} />;
}
