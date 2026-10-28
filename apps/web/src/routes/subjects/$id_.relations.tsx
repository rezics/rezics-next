import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient } from '../../kernel/client';
import { getLocale } from '../../paraglide/runtime.js';
import { keepSearch, loadSubject, subjectUrlForView } from '../../subject/load-subject';

const redirectRelations = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      !('locale' in input) ||
      typeof input.locale !== 'string' ||
      !('search' in input) ||
      typeof input.search !== 'string' ||
      input.search.length > 2048
    )
      throw notFound();
    return { id: input.id, locale: input.locale, search: input.search };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const result = await loadSubject(kernelClient(data.locale), data.id, data.locale as never);
    if (result.kind === 'missing') throw notFound();
    throw redirect({
      href: keepSearch(subjectUrlForView(result.value, 'relations'), data.search),
      statusCode: 301,
    });
  });

export const Route = createFileRoute('/subjects/$id_/relations')({
  loader: ({ params, location }) =>
    redirectRelations({ data: { id: params.id, locale: getLocale(), search: location.searchStr } }),
});
