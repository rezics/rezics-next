import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { DocumentBody } from '../../document-body';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { catalogueEntries } from '../catalogue/catalogue-entry';
import type { QuotationContext, QuotationPart, QuotationRead, QuotationText } from '../catalogue/quotation';
import { ViewHeading } from './view-heading';
import { SpoilerGate } from './values';
import { webUrl } from './shared';

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

function contextRole(kind: QuotationContext['kind'], locale: string) {
  const o = option(locale);
  if (kind === 'speaker') return m.quotation_speaker({}, o);
  if (kind === 'credited') return m.quotation_credited({}, o);
  if (kind === 'work') return m.quotation_work({}, o);
  return m.quotation_voice({}, o);
}

function contextText(context: QuotationContext, locale: string) {
  const o = option(locale);
  if (context.status === 'unknown') return m.quotation_unknown_context({}, o);
  if (context.status === 'concealed' || context.status === 'withheld') return m.quotation_concealed_context({}, o);
  if (context.status === 'restricted' && context.kind === 'speaker') return m.quotation_restricted_speaker({}, o);
  if (context.status === 'missing' && context.kind === 'speaker') return m.quotation_missing_speaker({}, o);
  if (context.status === 'unsupported') return m.quotation_unsupported({}, o);
  if (context.status === 'current') return context.label ?? m.quotation_concealed_context({}, o);
  return m.quotation_unknown_context({}, o);
}

function partStatus(part: QuotationPart, locale: string) {
  const o = option(locale);
  if (part.status === 'current') return undefined;
  if (part.status === 'concealed' || part.status === 'restricted' || part.status === 'withheld')
    return m.quotation_concealed_context({}, o);
  if (part.status === 'missing' || part.status === 'unknown') return m.quotation_unknown_context({}, o);
  return m.quotation_unsupported({}, o);
}

function textStatus(text: QuotationText, locale: string) {
  const o = option(locale);
  if (text.status === 'current') return undefined;
  if (text.status === 'missing') return m.quotation_unknown_context({}, o);
  if (text.status === 'withheld') return m.quotation_concealed_context({}, o);
  if (text.status === 'stale') return m.quotation_stale({}, o);
  if (text.status === 'unsupported') return m.quotation_unsupported({}, o);
  return m.quotation_unavailable({}, o);
}

function SourcePart({ part, locale }: { part: QuotationPart; locale: string }) {
  const status = partStatus(part, locale);
  const value = part.value ?? part.id;
  const internalHref =
    part.status === 'current' && part.id && part.value
      ? subjectHref({ id: part.id, label: part.value }, locale).href
      : undefined;
  const externalHref = part.status === 'current' && part.href && webUrl(part.href) ? part.href : undefined;
  return (
    <li className="min-w-0 break-words">
      <span className="me-2 text-muted-foreground">{part.label}:</span>
      {status ? (
        <span>{status}</span>
      ) : externalHref ? (
        <a className={linkClass} href={externalHref} target="_blank" rel="noopener noreferrer">
          {value}
        </a>
      ) : internalHref ? (
        <a className={linkClass} href={internalHref}>
          {value}
        </a>
      ) : (
        <span lang={part.language}>{value}</span>
      )}
    </li>
  );
}

function QuotationStatement({ text, locale }: { text: QuotationText; locale: string }) {
  const o = option(locale);
  const unavailable = textStatus(text, locale);
  const document = text.body?.ok ? text.body.document : undefined;
  const content =
    document?.availability === 'available' && document.body ? (
      <div lang={document.language} className="max-w-prose">
        <DocumentBody document={document.body} locale={locale} />
      </div>
    ) : text.text !== undefined ? (
      <p lang={text.language} className="max-w-prose whitespace-pre-wrap">
        {text.text}
      </p>
    ) : null;
  return (
    <section
      className="min-w-0 space-y-3 rounded-md border p-4 [overflow-wrap:anywhere]"
      data-statement-id={text.statementId}
      aria-label={`${m.quotation_text({}, o)}${text.language ? ` (${text.language})` : ''}`}
    >
      <h3 className="font-medium">{m.quotation_text({}, o)}</h3>
      {unavailable ? (
        <p role="status">{unavailable}</p>
      ) : text.spoiler ? (
        <SpoilerGate label={m.thread_reveal_spoiler({}, o)}>{content}</SpoilerGate>
      ) : (
        content
      )}
      {text.qualifiers.length > 0 && (
        <dl className="grid min-w-0 gap-2 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr]">
          {text.qualifiers.map((part) => (
            <div key={`${text.statementId}:${part.property}`} className="contents">
              <dt className="font-medium">{part.label}</dt>
              <dd className="min-w-0 break-words">
                {partStatus(part, locale) ?? part.value ?? part.id ?? m.quotation_unknown_context({}, o)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <section aria-label={m.quotation_source({}, o)} className="space-y-2">
        <h4 className="text-sm font-medium">{m.quotation_source({}, o)}</h4>
        {text.references.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.quotation_unknown_context({}, o)}</p>
        ) : (
          <ul className="space-y-2">
            {text.references.map((reference) => (
              <li
                key={`${reference.statementId}:${reference.hash}`}
                className="min-w-0 break-words"
                data-source-reference-hash={reference.hash}
                data-statement-id={reference.statementId}
              >
                <p className="text-sm text-muted-foreground">
                  {m.quotation_source_reference({ hash: reference.hash }, o)}
                </p>
                {reference.parts.length ? (
                  <ul className="space-y-1">
                    {reference.parts.map((part) => (
                      <SourcePart key={`${reference.hash}:${part.property}`} part={part} locale={locale} />
                    ))}
                  </ul>
                ) : (
                  <p role="status" className="text-sm">
                    {reference.status === 'withheld'
                      ? m.quotation_concealed_context({}, o)
                      : reference.status === 'unknown'
                        ? m.quotation_unknown_context({}, o)
                        : m.quotation_unsupported({}, o)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
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
  const queryClient = useQueryClient();
  const failureRef = useRef<HTMLParagraphElement>(null);
  const selectedRef = useRef<HTMLElement>(null);
  const requestSequence = useRef(0);
  const focusSelection = useRef(false);
  const [pending, setPending] = useState(false);
  const queryKey = ['quotation-explore', id, locale, quote] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => transport.read({ quote }),
    ...(initial === undefined ? {} : { initialData: initial }),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  useEffect(() => {
    requestSequence.current += 1;
    setPending(false);
    focusSelection.current = false;
    return () => {
      requestSequence.current += 1;
    };
  }, [id, locale, quote]);

  const current = !pending && !query.isFetching && !query.isError ? query.data : undefined;
  const read = current?.ok ? current : undefined;
  const error =
    current && !current.ok
      ? current
      : query.isError
        ? { ok: false as const, reason: 'unavailable' as const }
        : undefined;
  const title = pickText(read?.public.subject.labels ?? {}, locale);
  const factsHref = subjectHref({ id, label: title.text }, locale).href;
  const origin = returnTo ?? factsHref;
  const selected = read?.selected;

  useEffect(() => {
    if (error) failureRef.current?.focus();
  }, [error?.reason]);

  useEffect(() => {
    if (!pending && selected && focusSelection.current) {
      focusSelection.current = false;
      selectedRef.current?.focus();
    }
  }, [pending, selected?.id, selected?.observation]);

  async function request(input: Parameters<QuotationTransport['read']>[0]) {
    const sequence = ++requestSequence.current;
    focusSelection.current = true;
    setPending(true);
    let result: QuotationRead;
    try {
      result = await transport.read(input);
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    if (sequence !== requestSequence.current) return;
    queryClient.setQueryData<QuotationRead>(queryKey, result);
    setPending(false);
  }

  const loading = pending || query.isPending || query.isFetching;
  return (
    <article className="mx-auto w-full min-w-0 max-w-4xl space-y-6 [overflow-wrap:anywhere]" aria-busy={loading}>
      <ViewHeading label={m.quotation_title({}, o)} headingClassName="font-sans" />
      <p className="max-w-prose text-muted-foreground">{m.quotation_intro({}, o)}</p>
      {loading && <p role="status">{m.quotation_loading({}, o)}</p>}
      {error && (
        <p ref={failureRef} role="alert" tabIndex={-1}>
          {error.reason === 'denied'
            ? m.quotation_denied({}, o)
            : error.reason === 'stale'
              ? m.quotation_stale({}, o)
              : m.quotation_unavailable({}, o)}
        </p>
      )}
      {read && !read.admitted && (
        <section className="space-y-3" aria-live="polite">
          <p role="status">{m.quotation_unsupported({}, o)}</p>
        </section>
      )}
      {read?.admitted && (
        <div className="space-y-4">
          {read.rows.length === 0 && read.unsupportedCount === 0 && <p role="status">{m.quotation_empty({}, o)}</p>}
          {read.unsupportedCount > 0 && <p role="status">{m.quotation_unsupported({}, o)}</p>}
          {read.rows.length > 0 && (
            <nav aria-label={m.quotation_title({}, o)}>
              <ol className="space-y-2">
                {read.rows.map((row, index) => (
                  <li key={row.id}>
                    <Button
                      type="button"
                      variant={selected?.id === row.id ? 'default' : 'outline'}
                      className={actionClass}
                      aria-pressed={selected?.id === row.id}
                      disabled={loading}
                      onClick={() => void request({ quote: row.id, session: read.session })}
                    >
                      {m.quotation_open({ number: index + 1 }, o)}
                    </Button>
                  </li>
                ))}
              </ol>
            </nav>
          )}
          {read.next && (
            <Button
              type="button"
              variant="outline"
              className={actionClass}
              disabled={loading}
              onClick={() => void request({ cursor: read.next ?? undefined, session: read.session })}
            >
              {m.quotation_more({}, o)}
            </Button>
          )}
          {selected && (
            <section
              ref={selectedRef}
              tabIndex={-1}
              aria-label={m.quotation_text({}, o)}
              className="min-w-0 space-y-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              data-quotation-id={selected.id}
              data-source-observation={selected.observation}
            >
              {selected.statements.map((statement) => (
                <QuotationStatement
                  key={statement.statementId ?? statement.property}
                  text={statement}
                  locale={locale}
                />
              ))}
              <ul className="space-y-2">
                {selected.contexts.map((context, index) => (
                  <li
                    key={`${context.kind}:${context.statementId ?? index}:${context.property ?? ''}`}
                    data-statement-id={context.statementId}
                    className="min-w-0 break-words"
                  >
                    <span className="me-2 font-medium">{contextRole(context.kind, locale)}:</span>
                    {context.status === 'current' && context.id && context.label ? (
                      <a
                        className={linkClass}
                        href={subjectHref({ id: context.id, label: context.label }, locale).href}
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
                href={`${catalogueEntries.authored({ id: selected.id, title: title.text || m.quotation_title({}, o), locale }).href}?${new URLSearchParams({ returnTo: origin })}`}
              >
                {m.quotation_correct({}, o)}
              </a>
            </section>
          )}
        </div>
      )}
      {read && (
        <nav aria-label={m.quotation_return({}, o)} className="flex flex-wrap gap-3">
          <a className={linkClass} href={origin}>
            {m.quotation_return({}, o)}
          </a>
          {!read.admitted && (
            <a className={linkClass} href={factsHref}>
              {m.quotation_facts({}, o)}
            </a>
          )}
        </nav>
      )}
    </article>
  );
}
