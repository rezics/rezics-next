import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { catalogueEntries } from '../catalogue/catalogue-entry';
import type { QuotationContext, QuotationRead } from '../catalogue/quotation';
import { ViewHeading } from './view-heading';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export type QuotationTransport = {
  read: (input: {
    quote?: string | undefined;
    cursor?: string | undefined;
    session?: string | undefined;
  }) => Promise<QuotationRead>;
};

function option(locale: string) {
  return { locale: locale as never };
}

function contextText(context: QuotationContext, locale: string) {
  const o = option(locale);
  if (context.status === 'unknown') return m.quotation_unknown_context({}, o);
  if (context.status === 'concealed') return m.quotation_concealed_context({}, o);
  if (context.status === 'restricted') return m.quotation_restricted_speaker({}, o);
  if (context.status === 'missing') return m.quotation_missing_speaker({}, o);
  return context.label ?? '';
}

export function QuotationView({
  id,
  locale,
  quote,
  returnTo,
  transport,
  initial,
}: {
  id: string;
  locale: string;
  quote?: string | undefined;
  returnTo?: string | undefined;
  transport: QuotationTransport;
  initial?: QuotationRead | undefined;
}) {
  const o = option(locale);
  const failureRef = useRef<HTMLParagraphElement>(null);
  const [page, setPage] = useState<Extract<QuotationRead, { ok: true }>>();
  const query = useQuery({
    queryKey: ['quotation-explore', id, locale, quote],
    queryFn: () => transport.read({ quote }),
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
  const selected = read?.selected ?? read?.rows[0];
  return (
    <article
      className="mx-auto w-full min-w-0 max-w-4xl space-y-6 [overflow-wrap:anywhere]"
      aria-busy={query.isPending}
    >
      <ViewHeading label={m.quotation_title({}, o)} headingClassName="font-sans" />
      <p className="max-w-prose text-muted-foreground">{m.quotation_intro({}, o)}</p>
      {query.isPending && <p role="status">{m.quotation_loading({}, o)}</p>}
      {error && (
        <p ref={failureRef} role="alert" tabIndex={-1}>
          {error.reason === 'denied'
            ? m.quotation_denied({}, o)
            : error.reason === 'stale'
              ? m.quotation_stale({}, o)
              : m.quotation_unavailable({}, o)}
        </p>
      )}
      {read && !read.admitted && <p>{m.quotation_unsupported({}, o)}</p>}
      {read?.admitted && (
        <div className="space-y-4">
          {read.rows.length === 0 && <p>{m.quotation_empty({}, o)}</p>}
          <ul className="space-y-3">
            {read.rows.map((row) => (
              <li key={row.id}>
                <Button
                  type="button"
                  variant={selected?.id === row.id ? 'default' : 'outline'}
                  className={actionClass}
                  onClick={() =>
                    void transport
                      .read({ quote: row.id, session: read.session })
                      .then((value) => value.ok && setPage(value))
                  }
                >
                  {row.text || m.quotation_text({}, o)}
                </Button>
              </li>
            ))}
          </ul>
          {read.next && (
            <Button
              type="button"
              variant="outline"
              className={actionClass}
              onClick={() =>
                void transport
                  .read({ cursor: read.next ?? undefined, session: read.session })
                  .then((value) => value.ok && setPage(value))
              }
            >
              {m.quotation_more({}, o)}
            </Button>
          )}
          {selected && (
            <section className="space-y-3">
              {selected.language && <p lang={selected.language}>{selected.text}</p>}
              {!selected.language && selected.text && <p>{selected.text}</p>}
              {selected.body && !selected.body.ok && <p>{m.quotation_unavailable({}, o)}</p>}
              <ul className="space-y-1">
                {selected.contexts.map((context) => (
                  <li key={context.kind}>
                    {context.status === 'current' && context.id ? (
                      <a
                        className={linkClass}
                        href={subjectHref({ id: context.id, label: context.label ?? '' }, locale).href}
                      >
                        {contextText(context, locale)}
                      </a>
                    ) : (
                      contextText(context, locale)
                    )}
                  </li>
                ))}
              </ul>
              <a
                className={linkClass}
                href={`${catalogueEntries.authored({ id: selected.id, title: selected.text || title.text, locale }).href}?${new URLSearchParams({ returnTo: origin })}`}
              >
                {m.quotation_correct({}, o)}
              </a>
            </section>
          )}
        </div>
      )}
      {read && (
        <a className={linkClass} href={origin}>
          {m.quotation_return({}, o)}
        </a>
      )}
    </article>
  );
}
