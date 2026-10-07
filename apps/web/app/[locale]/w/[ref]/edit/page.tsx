import { permanentRedirect } from 'next/navigation';
import { localizedPath } from '../../../../../i18n/locale.ts';
import { requestLocale } from '../../../../../i18n/server.ts';
import { editHref } from '../../../../../features/work-levels-edit/route.ts';
import { loadWork } from '../../../../../features/work-page/read.ts';
import { WorkUnavailable } from '../../../../../features/work-page/work-states.tsx';
import { getMessages } from '../../../../../i18n/server.ts';

type Props = { params: Promise<{ ref: string }> };

/** `/w/{ref}/edit` opens the first edit section. */
export default async function EditIndexPage({ params }: Props) {
  const [{ ref }, locale] = await Promise.all([params, requestLocale()]);
  const work = await loadWork(ref, locale);
  if (!work.ok) return <WorkUnavailable messages={await getMessages('workPage', locale)} />;
  permanentRedirect(localizedPath(editHref(ref, 'parts'), locale));
}
