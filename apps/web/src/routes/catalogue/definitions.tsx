import { createFileRoute, notFound } from '@tanstack/react-router';
import { DefinitionGuide } from '../../features/catalogue/definition-guide-view';
import {
  guideAddress,
  readDefinitionGuide,
  readDefinitionGuideDirectory,
  readDefinitionGuideType,
} from '../../features/catalogue/definition-guide-actions';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/catalogue/definitions')({
  staticData: { publicCache: false },
  validateSearch: guideAddress,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const result = await readDefinitionGuide({ data: { address: deps, locale: getLocale() } });
    if (!result.ok && result.reason === 'concealed') throw notFound();
    return result;
  },
  head: ({ match }) =>
    pageHead({ title: m.guide_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: GuideRoute,
});

function GuideRoute() {
  const address = Route.useSearch();
  const initial = Route.useLoaderData();
  return (
    <DefinitionGuide
      key={JSON.stringify(address)}
      locale={getLocale()}
      address={address}
      initial={initial}
      transport={{
        read: (locale = getLocale()) => readDefinitionGuide({ data: { address, locale } }),
        directory: (locale, query, cursor) =>
          readDefinitionGuideDirectory({ data: { query, ...(cursor ? { cursor } : {}), locale } }),
        exact: (locale, typeId) => readDefinitionGuideType({ data: { typeId, locale } }),
      }}
    />
  );
}
