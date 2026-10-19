import { ReleasePageEnd } from '../../../../../features/work-levels/pages.tsx';
import { parseReleaseId } from '../../../../../features/work-levels/route.ts';
import { PageContainer } from '../../../../../features/shell/page.tsx';
import { requestLocale } from '../../../../../i18n/server.ts';

/** The Release's cached selected sources follow main in the shell's page-end slot. */
export default async function ReleaseSourcesRoute({ params }: { params: Promise<{ id: string }> }) {
  const [{ id: segment }, locale] = await Promise.all([params, requestLocale()]);
  const id = parseReleaseId(segment);
  if (!id) return null;
  return <PageContainer className="max-w-4xl pt-0 sm:pt-0 lg:pt-0">
    <ReleasePageEnd id={id} locale={locale} />
  </PageContainer>;
}
