import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { CatalogueFileProfileSession } from '../../features/catalogue/catalogue-file-profile/session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, subjectHref } from '../../subject/subject-href';
import { catalogueFileSourceId } from '../../features/catalogue/catalogue-file-reader/navigation';
import {
  catalogueFileCorrectionReturnHref,
  CATALOGUE_FILE_CORRECTION_ORIGIN_LIMIT,
  parseCatalogueFileCorrectionOrigin,
} from '../../features/catalogue/catalogue-file-profile/origin';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalFileSearch(search: string, locale: string): string {
  const input = new URLSearchParams(search);
  const output = new URLSearchParams();
  const origins = input.getAll('origin');
  const vias = input.getAll('via');
  const unboundContext = input.has('context') || input.has('realm');
  if (origins.length) {
    const value = origins[0]!;
    output.set(
      'origin',
      origins.length === 1 &&
        vias.length === 0 &&
        !unboundContext &&
        value.length <= CATALOGUE_FILE_CORRECTION_ORIGIN_LIMIT &&
        new TextEncoder().encode(value).byteLength <= CATALOGUE_FILE_CORRECTION_ORIGIN_LIMIT
        ? value
        : '!',
    );
  }
  if (vias.length === 1) {
    const via = catalogueFileCorrectionReturnHref(vias[0], locale, catalogueFileSourceId(input.get('fileSource')));
    if (via) output.set('via', via);
  }
  const sources = input.getAll('fileSource');
  if (sources.length === 1) {
    const source = catalogueFileSourceId(sources[0]);
    if (source) output.set('fileSource', source);
  }
  const reviewProperty = input.getAll('reviewProperty');
  const candidates = input.getAll('candidate');
  if (
    origins.length === 0 &&
    reviewProperty.length === 1 &&
    candidates.length === 1 &&
    reviewProperty[0]!.length <= 256 &&
    uuid.test(candidates[0]!)
  ) {
    output.set('reviewProperty', reviewProperty[0]!);
    output.set('candidate', candidates[0]!);
  }
  return output.toString();
}

const canonicalFile = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; slug: string; locale: string; search: string }) => {
    if (
      !input ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      typeof input.slug !== 'string' ||
      input.slug.length > 128 ||
      typeof input.locale !== 'string' ||
      typeof input.search !== 'string' ||
      input.search.length > 32768 ||
      new TextEncoder().encode(input.search).byteLength > 32768
    )
      throw notFound();
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const [{ kernelClient }, { loadSubject }] = await Promise.all([
      import('../../kernel/client'),
      import('../../subject/load-subject'),
    ]);
    const canonical = await loadSubject(kernelClient(data.locale), data.id, data.locale as never);
    if (canonical.kind === 'missing') throw notFound();
    const search = canonicalFileSearch(data.search, data.locale);
    if (
      canonical.value.id !== data.id ||
      canonical.value.slug !== data.slug ||
      search !== data.search.replace(/^\?/u, '')
    )
      throw redirect(
        canonicalRedirect(
          `${subjectHref({ id: canonical.value.id, label: canonical.value.label }, data.locale).href}/file`,
          search,
        ),
      );
    return { id: canonical.value.id };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/file')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    via: catalogueFileCorrectionReturnHref(input.via, getLocale(), catalogueFileSourceId(input.fileSource)),
    fileSource: catalogueFileSourceId(input.fileSource),
    origin:
      input.context !== undefined || input.realm !== undefined
        ? { kind: 'invalid' as const }
        : parseCatalogueFileCorrectionOrigin(
            input.origin,
            getLocale(),
            catalogueFileSourceId(input.fileSource),
            input.via !== undefined,
          ),
    reviewProperty:
      typeof input.reviewProperty === 'string' && input.reviewProperty.length <= 256 ? input.reviewProperty : undefined,
    candidate:
      typeof input.candidate === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.candidate)
        ? input.candidate
        : undefined,
  }),
  loader: ({ params, location }) =>
    canonicalFile({
      data: { ...params, locale: getLocale(), search: location.searchStr },
    }),
  head: () => ({ meta: [{ title: m.catalogue_file_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: FileRoute,
});

function FileRoute() {
  const { reviewProperty, candidate, fileSource, via, origin } = Route.useSearch();
  const id = Route.useLoaderData().id;
  const originMatchesSubject = origin.kind === 'valid' && origin.origin.subject.toLowerCase() === id.toLowerCase();
  const parsedOrigin = originMatchesSubject ? origin.origin : undefined;
  return (
    <CatalogueFileProfileSession
      id={id}
      locale={getLocale()}
      context={parsedOrigin?.context}
      realm={parsedOrigin?.realm}
      origin={parsedOrigin}
      originInvalid={origin.kind === 'invalid' || (origin.kind === 'valid' && !originMatchesSubject)}
      restartWithoutOrigin={origin.kind === 'absent'}
      returnHref={(origin.kind === 'valid' ? origin.origin.returnHref : undefined) ?? via}
      returnSourceId={fileSource}
      initialReview={origin.kind === 'absent' && reviewProperty && candidate ? { property: reviewProperty, candidate } : undefined}
    />
  );
}
