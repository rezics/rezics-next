import { createFileRoute, Link, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import type { ReactNode } from 'react';
import { loadSubjectPage, SubjectPage, subjectPageTitle } from '../../features/pages/subject';
import { kernelClient } from '../../kernel/client';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';

// Page documents type their props as unknown. The kernel already returned JSON.
const readSubject = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      !('locale' in input) ||
      typeof input.locale !== 'string'
    )
      throw notFound();
    return { id: input.id, locale: input.locale };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const result = await loadSubjectPage(kernelClient(), data.id);
    if (result.kind === 'missing') throw notFound();
    if (result.kind === 'redirect') throw redirect({ href: `/${data.locale}/subjects/${result.id}`, statusCode: 308 });
    return result.page;
  });

export const Route = createFileRoute('/subjects/$id')({
  loader: ({ params }) => readSubject({ data: { id: params.id, locale: getLocale() } }),
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData ? subjectPageTitle(loaderData, getLocale()) : m.not_found_heading() }],
  }),
  component: SubjectRoute,
});

function SubjectLink({ href, lang, children }: { href: string; lang?: string; children: ReactNode }) {
  const id = /^\/[^/]+\/subjects\/([^/?#]+)$/.exec(href)?.[1];
  if (!id)
    return (
      <a href={href} lang={lang}>
        {children}
      </a>
    );
  return (
    <Link to="/subjects/$id" params={{ id: decodeURIComponent(id) }} lang={lang}>
      {children}
    </Link>
  );
}

function SubjectRoute() {
  const page = Route.useLoaderData();
  return (
    <SubjectPage
      page={page}
      locale={getLocale()}
      messages={{
        unknown: m.subject_value_unknown(),
        none: m.subject_value_none(),
        unlabelled: m.subject_value_unlabelled(),
        sources: m.subject_sources(),
        aliases: m.subject_aliases(),
        search: m.search_submit(),
      }}
      link={SubjectLink}
    />
  );
}
