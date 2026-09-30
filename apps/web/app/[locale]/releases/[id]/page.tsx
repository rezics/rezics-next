import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { copyOf } from '../../../../features/work-levels/messages.ts';
import { ReleasePage } from '../../../../features/work-levels/pages.tsx';
import { parseReleaseId } from '../../../../features/work-levels/route.ts';
import { PageContainer } from '../../../../features/shell/page.tsx';
import { getMessages, requestLocale } from '../../../../i18n/server.ts';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata(): Promise<Metadata> {
  return { title: copyOf(await requestLocale()).release };
}

/** `/releases/{id}`: one release with its realizations, the Works it covers and their Main Versions. */
export default async function ReleaseRoute({ params }: Props) {
  const [{ id: segment }, locale] = await Promise.all([params, requestLocale()]);
  const id = parseReleaseId(segment);
  if (!id) notFound();
  return <PageContainer className="max-w-4xl">
    <ReleasePage id={id} locale={locale} pageMessages={await getMessages('workPage', locale)} />
  </PageContainer>;
}
