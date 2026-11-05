import { createFileRoute } from '@tanstack/react-router';
import * as v from 'valibot';
import { ConfiguredList } from '../features/pages/type-list-page';
import { typeListQuery, type TypeListAdmissionInput } from '../features/pages/type-list-query';
import { hasSelectedRealmTarget, typeListTargetFromPage } from '../features/pages/type-list-model';
import { sessionQuery } from '../session/query';
import { getLocale } from '../paraglide/runtime.js';

export const Route = createFileRoute('/search_/list')({
  staticData: { publicCache: false },
  validateSearch: v.object({
    list: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/)),
    page: v.pipe(v.string(), v.maxLength(2048)),
    cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4864))),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps, context }) => {
    const selectedRealm = hasSelectedRealmTarget(typeListTargetFromPage(deps.page));
    let admission: TypeListAdmissionInput;
    if (!selectedRealm) {
      admission = { state: 'public', incarnation: 'public', mode: 'public' };
    } else if (typeof window === 'undefined') {
      // The server read admits its own prepared credential; hydration carries that provenance until
      // the browser has observed its current session.
      admission = { state: 'unknown', incarnation: crypto.randomUUID(), mode: 'initial-hydration' };
    } else {
      const session = context.queryClient.getQueryData(sessionQuery.queryKey) as
        | { state: 'signed-in' | 'signed-out' | 'unavailable'; subject?: string | null }
        | undefined;
      const state = session?.state ?? 'unknown';
      admission = {
        state,
        ...(state === 'unknown' ? {} : { expectedReader: state === 'signed-in' ? (session?.subject ?? null) : null }),
        incarnation: crypto.randomUUID(),
        mode: 'current',
      };
    }
    return context.queryClient.fetchQuery(typeListQuery(getLocale(), deps.list, deps.page, deps.cursor, admission));
  },
  head: () => ({ meta: [{ name: 'robots', content: 'noindex, follow' }] }),
  component: ConfiguredListRoute,
});

function ConfiguredListRoute() {
  const { list, page, cursor } = Route.useSearch();
  const initialData = Route.useLoaderData();
  return (
    <ConfiguredList
      list={list}
      page={page}
      {...(cursor !== undefined ? { cursor } : {})}
      locale={getLocale()}
      initialData={initialData}
    />
  );
}
