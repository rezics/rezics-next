import { createFileRoute } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import * as v from 'valibot';
import { TypeListPage } from '../features/pages/type-list-page';
import { typeListQuery } from '../features/pages/type-list-query';
import { getLocale } from '../paraglide/runtime.js';

export const Route = createFileRoute('/search_/list')({
  staticData: { publicCache: false },
  validateSearch: v.object({
    list: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/)),
    page: v.pipe(v.string(), v.maxLength(2048)),
    cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4864))),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps, context }) =>
    context.queryClient.fetchQuery(typeListQuery(getLocale(), deps.list, deps.page, deps.cursor)),
  head: () => ({ meta: [{ name: 'robots', content: 'noindex, follow' }] }),
  component: ConfiguredList,
});

function ConfiguredList() {
  const { list, page, cursor } = Route.useSearch();
  const locale = getLocale();
  const { data } = useSuspenseQuery(typeListQuery(locale, list, page, cursor));
  return <TypeListPage {...data} locale={locale} />;
}
