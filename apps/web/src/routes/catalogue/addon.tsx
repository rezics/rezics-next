import { createFileRoute } from '@tanstack/react-router';
import { AddonProfileSession } from '../../features/catalogue/addon-profile-session';
import { classificationHandoffSearch } from '../../features/catalogue/classification-create-return';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/catalogue/addon')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    work: typeof input.work === 'string' ? input.work : undefined,
    classificationHandoff: classificationHandoffSearch(input),
  }),
  head: () => ({ meta: [{ title: m.addon_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: AddonRoute,
});
function AddonRoute() {
  const { work, classificationHandoff } = Route.useSearch();
  return (
    <AddonProfileSession
      locale={getLocale()}
      work={work}
      {...(classificationHandoff ? { classificationHandoffToken: classificationHandoff } : {})}
    />
  );
}
