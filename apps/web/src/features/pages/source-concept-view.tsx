import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { catalogueEntries } from '../catalogue/catalogue-entry';
import { ConceptHierarchy } from '../catalogue/definition-guide-view';
import type { ConceptRead } from '../catalogue/source-concept-explorer';
import { ViewHeading } from './view-heading';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export type ConceptTransport = {
  read: (input: { cursor?: string | undefined; session?: string | undefined }) => Promise<ConceptRead>;
};

export function SourceConceptView({
  id,
  locale,
  role,
  returnTo,
  transport,
  initial,
}: {
  id: string;
  locale: string;
  role?: string | undefined;
  returnTo?: string | undefined;
  transport: ConceptTransport;
  initial?: ConceptRead | undefined;
}) {
  const o = { locale: locale as never };
  const failureRef = useRef<HTMLParagraphElement>(null);
  const [page, setPage] = useState<Extract<ConceptRead, { ok: true }>>();
  const query = useQuery({
    queryKey: ['concept-explore', id, locale, role],
    queryFn: () => transport.read({}),
    initialData: initial,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const read = page ?? (query.data?.ok ? query.data : undefined);
  const error = !read && query.data && !query.data.ok ? query.data : undefined;
  const title = pickText(read?.public.subject.labels ?? {}, locale);
  const origin = returnTo || subjectHref({ id, label: title.text }, locale).href;
  return (
    <article className="mx-auto w-full min-w-0 max-w-4xl space-y-6 [overflow-wrap:anywhere]" aria-busy={query.isPending}>
      <ViewHeading label={m.concept_explore_title({}, o)} headingClassName="font-sans" />
      <p className="max-w-prose text-muted-foreground">{m.concept_explore_intro({}, o)}</p>
      {query.isPending && <p role="status">{m.concept_explore_loading({}, o)}</p>}
      {error && (
        <p ref={failureRef} role="alert" tabIndex={-1}>
          {error.reason === 'denied' ? m.concept_explore_denied({}, o) : m.concept_explore_unreadable({}, o)}
        </p>
      )}
      {read && !read.admitted && <p>{m.concept_explore_unsupported({}, o)}</p>}
      {read?.admitted && (
        <div className="space-y-4">
          {read.retired && <p>{m.concept_explore_retired({}, o)}</p>}
          {read.spoiler && <p>{m.concept_explore_spoiler({}, o)}</p>}
          {read.definition && <p>{read.definition.text}</p>}
          {read.aliases.length > 0 && (
            <p>
              {m.concept_explore_aliases({}, o)}:{' '}
              {read.aliases.map((alias) => alias.text).join(' · ')}
            </p>
          )}
          <section>
            <h2 className="font-sans text-lg font-semibold">{m.concept_explore_scheme({}, o)}</h2>
            <ul>
              {read.schemes.map((scheme) => (
                <li key={scheme.id}>
                  <a className={linkClass} href={subjectHref({ id: scheme.id, label: scheme.label }, locale).href}>
                    {scheme.label || scheme.id}
                  </a>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="font-sans text-lg font-semibold">{m.concept_explore_source_code({}, o)}</h2>
            <ul>
              {read.codes.map((code) => (
                <li key={`${code.property}:${code.value}`}>
                  {code.unknown ? m.concept_explore_unknown_role({}, o) : code.label}: {code.value}
                </li>
              ))}
            </ul>
          </section>
          <ConceptHierarchy
            locale={locale}
            rows={read.hierarchy}
            empty={m.concept_explore_empty({}, o)}
            broader={m.concept_explore_broader({}, o)}
            narrower={m.concept_explore_direction({}, o)}
          />
          {read.next && (
            <Button
              type="button"
              variant="outline"
              className={actionClass}
              onClick={() => void transport.read({ cursor: read.next ?? undefined, session: read.session }).then((value) => value.ok && setPage(value))}
            >
              {m.concept_explore_more({}, o)}
            </Button>
          )}
          <a className={linkClass} href={`${catalogueEntries.facts({ id, label: title.text, locale }).href}?${new URLSearchParams({ returnTo: origin })}`}>
            {m.concept_explore_correct({}, o)}
          </a>
          <a className={linkClass} href={origin}>
            {m.concept_explore_return({}, o)}
          </a>
        </div>
      )}
    </article>
  );
}
