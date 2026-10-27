import { createFileRoute, notFound, redirect, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import {
  loadSubjectPage,
  SubjectPage,
  pageRelationProperties,
  subjectPageJsonLd,
  subjectPageTitle,
  subjectPageType,
} from '../../features/pages/subject';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../../features/pages/route-support';
import { subjectTabs } from '../../features/pages/views';
import { kernelClient } from '../../kernel/client';
import { loadSubjectLibrarySlot } from '../../library/subject-slot';
import { SubjectLibrarySlot } from '../../library/subject-slot-view';
import type { SessionEnv } from '../../session/client';
import { relationLabels, typeFrame } from '../../subject/definitions';
import { loadReader } from '../../subject/load-reader';
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
    const request = getRequest();
    const [result, library, reader] = await Promise.all([
      loadSubjectPage(client, data.id),
      loadSubjectLibrarySlot(
        client,
        request,
        env as Partial<SessionEnv>,
        data.id,
        data.loadCollections,
        data.slotResult,
      ),
      loadReader(client, request, env as Partial<SessionEnv>),
    ]);
    if (result.kind === 'missing') throw notFound();
    if (result.kind === 'redirect') throw redirect({ href: `/${data.locale}/subjects/${result.id}`, statusCode: 308 });
    const type = subjectPageType(result.page);
    const [frame, relations] = await Promise.all([
      type ? typeFrame(type, data.locale) : Promise.resolve<Awaited<ReturnType<typeof typeFrame>>>({}),
      relationLabels(pageRelationProperties(result.page), data.locale),
    ]);
    return { page: result.page, library, reader, frame, relations, tabs: subjectTabs(result.page) };
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

function SubjectRoute() {
  const { page, library, reader, frame, relations, tabs } = Route.useLoaderData();
  const nonce = useRouter().options.ssr?.nonce;
  return (
    <SubjectPage
      page={page}
      locale={getLocale()}
      messages={subjectPageMessages()}
      reader={reader}
      {...(frame.label ? { typeLabel: frame.label } : {})}
      {...(frame.ratio ? { ratio: frame.ratio } : {})}
      relations={relations}
      link={SubjectLink}
      tabs={tabs}
      tabLabels={viewTabLabels()}
      invitation={m.subject_empty()}
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
