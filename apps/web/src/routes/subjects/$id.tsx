import { createFileRoute, Link, notFound, redirect, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { ReactNode } from 'react';
import { loadSubjectPage, SubjectPage, subjectPageJsonLd, subjectPageTitle } from '../../features/pages/subject';
import { kernelClient } from '../../kernel/client';
import { loadSubjectLibrarySlot } from '../../library/subject-slot';
import { SubjectLibrarySlot } from '../../library/subject-slot-view';
import type { SessionEnv } from '../../session/client';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { env } from 'cloudflare:workers';

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
      typeof input.locale !== 'string' ||
      !('loadCollections' in input) ||
      typeof input.loadCollections !== 'boolean' ||
      !('slotResult' in input) ||
      (input.slotResult !== undefined && typeof input.slotResult !== 'string')
    )
      throw notFound();
    return {
      id: input.id,
      locale: input.locale,
      loadCollections: input.loadCollections,
      slotResult: input.slotResult as string | undefined,
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const client = kernelClient(data.locale);
    const [result, library] = await Promise.all([
      loadSubjectPage(client, data.id),
      loadSubjectLibrarySlot(
        client,
        getRequest(),
        env as Partial<SessionEnv>,
        data.id,
        data.loadCollections,
        data.slotResult,
      ),
    ]);
    if (result.kind === 'missing') throw notFound();
    if (result.kind === 'redirect') throw redirect({ href: `/${data.locale}/subjects/${result.id}`, statusCode: 308 });
    return { page: result.page, library };
  });

export const Route = createFileRoute('/subjects/$id')({
  validateSearch: (search: Record<string, unknown>): { slot?: 'collections'; slotResult?: string } => ({
    ...(search.slot === 'collections' ? { slot: 'collections' as const } : {}),
    ...(typeof search.slotResult === 'string' ? { slotResult: search.slotResult } : {}),
  }),
  loaderDeps: ({ search }) => ({ slot: search.slot, slotResult: search.slotResult }),
  loader: ({ params, deps }) =>
    readSubject({
      data: {
        id: params.id,
        locale: getLocale(),
        loadCollections: deps.slot === 'collections',
        slotResult: deps.slotResult,
      },
    }),
  head: ({ loaderData }) => {
    const locale = getLocale();
    const jsonLd = loaderData ? subjectPageJsonLd(loaderData.page, locale) : undefined;
    return {
      meta: [{ title: loaderData ? subjectPageTitle(loaderData.page, locale) : m.not_found_heading() }],
      ...(jsonLd ? { scripts: [{ type: 'application/ld+json', children: jsonLd }] } : {}),
    };
  },
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
  const { page, library } = Route.useLoaderData();
  const nonce = useRouter().options.ssr?.nonce;
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
      {...(nonce !== undefined ? { nonce } : {})}
      renderJsonLd={false}
      actions={(subject) => (
        <SubjectLibrarySlot
          subject={{ id: subject.id, type: subject.type, label: subjectPageTitle(page, subject.locale) }}
          locale={subject.locale}
          data={library}
        />
      )}
    />
  );
}
