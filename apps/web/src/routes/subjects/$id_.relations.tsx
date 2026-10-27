import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { ReactNode } from 'react';
import { env } from 'cloudflare:workers';
import { RELATIONS_PAGE_LIMIT, RelationsView } from '../../features/pages/relations-view';
import { pageText } from '../../features/pages/shared';
import { kernelClient } from '../../kernel/client';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import type { SessionEnv } from '../../session/client';
import { relationLabels } from '../../subject/definitions';
import { originalLanguage } from '../../subject/language';
import { loadReader } from '../../subject/load-reader';

const subjectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const curiePattern = /^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9_.-]+$/;

const readRelations = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const { id, locale, property, cursor } = record;
    if (typeof id !== 'string' || !subjectIdPattern.test(id) || typeof locale !== 'string' || locale.length > 35)
      throw notFound();
    if (
      property !== undefined &&
      (typeof property !== 'string' || !curiePattern.test(property) || property.length > 128)
    )
      throw notFound();
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048)) throw notFound();
    return { id, locale, property: property as string | undefined, cursor: cursor as string | undefined };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const client = kernelClient(data.locale);
    const [subject, links, reader] = await Promise.all([
      client.subjects({ id: data.id }).get(),
      client.subjects({ id: data.id }).links.get({
        query: {
          limit: RELATIONS_PAGE_LIMIT,
          ...(data.property ? { property: data.property } : {}),
          ...(data.cursor ? { cursor: data.cursor } : {}),
        },
      }),
      loadReader(client, getRequest(), env as Partial<SessionEnv>),
    ]);
    if (subject.error || !subject.data?.subject) throw notFound();
    const found = subject.data.subject;
    const body: Record<string, unknown> = links.error ? {} : (links.data as unknown as Record<string, unknown>);
    const properties = new Set<string>(data.property ? [data.property] : []);
    if (Array.isArray(body.links))
      for (const link of body.links) if (typeof link?.property === 'string') properties.add(link.property);
    return {
      title: pageText(found.labels, data.locale, originalLanguage(found as never)).text,
      relations: await relationLabels(properties, data.locale),
      body,
      reader,
    };
  });

export const Route = createFileRoute('/subjects/$id_/relations')({
  validateSearch: (search: Record<string, unknown>): { property?: string; cursor?: string } => ({
    ...(typeof search.property === 'string' && search.property.length <= 128 ? { property: search.property } : {}),
    ...(typeof search.cursor === 'string' && search.cursor.length <= 2048 ? { cursor: search.cursor } : {}),
  }),
  loaderDeps: ({ search }) => ({ property: search.property, cursor: search.cursor }),
  loader: ({ params, deps }) =>
    readRelations({
      data: { id: params.id, locale: getLocale(), property: deps.property, cursor: deps.cursor },
    }),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.title || m.subject_relations() }] }),
  component: RelationsRoute,
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

function RelationsRoute() {
  const { title, relations, body, reader } = Route.useLoaderData();
  const { id } = Route.useParams();
  const { property } = Route.useSearch();
  return (
    <RelationsView
      locale={getLocale()}
      subject={id}
      title={title || m.subject_value_unlabelled()}
      data={{ body, property: property ?? null }}
      relations={relations}
      value={{
        locale: getLocale(),
        link: SubjectLink,
        reader,
        unlabelled: m.subject_value_unlabelled(),
        spoilerShow: m.subject_spoiler_show(),
        labels: {
          spoilerShow: m.subject_spoiler_show(),
          documentSpoiler: m.thread_reveal_spoiler(),
          cover: {
            withheld: m.subject_cover_withheld(),
            reveal: m.subject_cover_reveal(),
            credit: m.subject_cover_credit(),
            via: m.subject_cover_via(),
          },
        },
      }}
    />
  );
}
