import { useRef, type ReactNode } from 'react';
import { languageName } from '../../subject/language';
import { correctionProposalAvailability } from '../catalogue/statement-editor';
import { ValueExplanationEntry } from '../catalogue/value-explanation-entry';
import { useQuotationVisit } from './quotation-reading/visit';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { DocumentBody } from '../../document-body';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { catalogueEntries } from '../catalogue/catalogue-entry';
import type {
  QuotationAssertion,
  QuotationContext,
  QuotationPart,
  QuotationRead,
  QuotationRow,
  QuotationText,
} from '../catalogue/quotation';
import { ViewHeading } from './view-heading';
import { SpoilerGate } from './values';
import { webUrl } from './shared';

const actionClass = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2';
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
  if (context.status === 'concealed') return m.quotation_context_concealed({}, o);
  if (context.status === 'withheld') return m.quotation_context_withheld({}, o);
  if (context.status === 'restricted' && context.kind === 'speaker') return m.quotation_restricted_speaker({}, o);
  if (context.status === 'missing' && context.kind === 'speaker') return m.quotation_missing_speaker({}, o);
  if (context.status === 'restricted') return m.quotation_context_restricted({}, o);
  if (context.status === 'missing') return m.quotation_context_missing({}, o);
  if (context.status === 'unsupported') return m.quotation_unsupported({}, o);
  if (context.status === 'current') return context.label ?? m.quotation_concealed_context({}, o);
  return m.quotation_unknown_context({}, o);
}

function partStatus(part: QuotationPart, locale: string) {
  const o = option(locale);
  if (part.status === 'current') return undefined;
  if (part.status === 'concealed') return m.quotation_context_concealed({}, o);
  if (part.status === 'restricted') return m.quotation_context_restricted({}, o);
  if (part.status === 'withheld') return m.quotation_concealed_context({}, o);
  if (part.status === 'missing') return m.quotation_context_missing({}, o);
  if (part.status === 'unknown') return m.quotation_unknown_context({}, o);
  return m.quotation_unsupported({}, o);
}

function correctionControl(
  read: Extract<QuotationRead, { ok: true }>,
  selected: QuotationRow,
  locale: string,
  origin: string,
  title: string,
) {
  const o = option(locale);
  const advised = read.actions?.find(
    (action) => action.action === 'statement:propose' && action.operationId === 'subject.propose',
  );
  const state = read.viewerActions
    ? correctionProposalAvailability(read.viewerActions)
    : (advised?.state ?? 'unavailable');
  const href = `${catalogueEntries.authored({ id: selected.id, title: title || m.quotation_title({}, o), locale }).href}?${new URLSearchParams({ returnTo: origin })}`;
  return (
    <div className="space-y-2">
      <a className={linkClass} href={href}>
        {state === 'allowed' ? m.quotation_correct({}, o) : m.quotation_authoring({}, o)}
      </a>
      {state !== 'allowed' && (
        <p role="status" data-action-state={state}>
          {state === 'denied'
            ? m.quotation_denied({}, o)
            : state === 'withheld'
              ? m.quotation_concealed_context({}, o)
              : state === 'unsupported'
                ? m.quotation_unsupported({}, o)
                : m.quotation_unavailable({}, o)}
        </p>
      )}
    </div>
  );
}

function textStatus(text: QuotationText, locale: string) {
  const o = option(locale);
  if (text.status === 'current') return undefined;
  if (text.status === 'missing') return m.quotation_body_missing({}, o);
  if (text.status === 'withheld') return m.quotation_concealed_context({}, o);
  if (text.status === 'stale') return m.quotation_stale({}, o);
  if (text.status === 'unsupported') return m.quotation_unsupported({}, o);
  return m.quotation_unavailable({}, o);
}

function SourcePart({ part, locale, returnTo }: { part: QuotationPart; locale: string; returnTo: string }) {
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
        <a className={linkClass} href={`${internalHref}?${new URLSearchParams({ returnTo })}`}>
          {value}
        </a>
      ) : (
        <span lang={part.language}>{value}</span>
      )}
    </li>
  );
}

function AssertionGate({
  spoiler,
  locale,
  children,
}: {
  spoiler?: boolean | undefined;
  locale: string;
  children: ReactNode;
}) {
  const o = option(locale);
  return spoiler ? (
    <SpoilerGate label={m.thread_reveal_spoiler({}, o)} hideLabel={m.subject_spoiler_hide({}, o)} unmountOnHide>
      {children}
    </SpoilerGate>
  ) : (
    children
  );
}

/** The exact address and original metadata travel with the assertion, inside its own disclosure. */
function Inspection({
  assertion,
  locale,
  returnTo,
}: {
  assertion?: QuotationAssertion | undefined;
  locale: string;
  returnTo: string;
}) {
  if (!assertion) return null;
  const o = option(locale);
  return (
    <>
      <ValueExplanationEntry
        id={assertion.holder}
        property={assertion.statement.property.id}
        statement={assertion.statement.id}
        context={assertion.context}
        title=""
        locale={locale}
        returnTo={returnTo}
      />
      <details>
        <summary className={linkClass}>{m.catalogue_technical_details({}, o)}</summary>
        <dl className="break-all">
          <dt>{m.concept_visit_holder({}, o)}</dt>
          <dd>{assertion.holder}</dd>
          <dt>{m.concept_visit_property({}, o)}</dt>
          <dd>{assertion.statement.property.id}</dd>
          <dt>{m.settings_verification_statement({}, o)}</dt>
          <dd>{assertion.statement.id}</dd>
          <dt>{m.own_drafts_revision({}, o)}</dt>
          <dd>{assertion.revision}</dd>
          <dt>{m.prq_context({}, o)}</dt>
          <dd>{assertion.context}</dd>
          <dt>{m.concept_explore_source_release({}, o)}</dt>
          <dd>{assertion.release}</dd>
        </dl>
      </details>
    </>
  );
}

function Evidence({
  qualifiers,
  references,
  locale,
  returnTo,
}: {
  qualifiers: QuotationPart[];
  references: QuotationText['references'];
  locale: string;
  returnTo: string;
}) {
  const o = option(locale);
  return (
    <div className="space-y-3">
      {qualifiers.length > 0 && (
        <ul className="space-y-2 text-sm">
          {qualifiers.map((part, index) => (
            <SourcePart key={index} part={part} locale={locale} returnTo={returnTo} />
          ))}
        </ul>
      )}
      <section aria-label={m.quotation_source({}, o)} className="space-y-2">
        <h4 className="text-sm font-medium">{m.quotation_source({}, o)}</h4>
        {references.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.quotation_unknown_context({}, o)}</p>
        ) : (
          <ul className="space-y-2">
            {references.map((reference, index) => (
              <li
                key={`${reference.hash}:${index}`}
                className="min-w-0 break-words"
                data-source-reference-hash={reference.hash}
                data-statement-id={reference.statementId}
              >
                <p className="text-sm text-muted-foreground">
                  {m.quotation_source_reference({ hash: reference.hash }, o)}
                </p>
                {reference.parts.length ? (
                  <ul className="space-y-1">
                    {reference.parts.map((part, index) => (
                      <SourcePart key={index} part={part} locale={locale} returnTo={returnTo} />
                    ))}
                  </ul>
                ) : (
                  <p role="status">
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
    </div>
  );
}

function QuotationStatement({ text, locale, returnTo }: { text: QuotationText; locale: string; returnTo: string }) {
  const o = option(locale);
  const unavailable = textStatus(text, locale);
  const document = text.body?.ok ? text.body.document : undefined;
  return (
    <section
      className="min-w-0 space-y-3 rounded-md border p-4 [overflow-wrap:anywhere]"
      aria-label={`${m.quotation_text({}, o)}${text.language ? ` (${text.language})` : ''}`}
    >
      <h3 className="font-medium">{m.quotation_text({}, o)}</h3>
      <AssertionGate spoiler={text.spoiler} locale={locale}>
        <div className="space-y-3" data-statement-id={text.statementId}>
          {unavailable ? (
            <p role="status">{unavailable}</p>
          ) : document?.availability === 'available' && document.body ? (
            <div lang={document.language} className="max-w-prose">
              <DocumentBody document={document.body} locale={locale} />
            </div>
          ) : text.text !== undefined ? (
            <p lang={text.language} className="max-w-prose whitespace-pre-wrap">
              {text.text}
            </p>
          ) : null}
          <Evidence qualifiers={text.qualifiers} references={text.references} locale={locale} returnTo={returnTo} />
          <Inspection assertion={text.assertion} locale={locale} returnTo={returnTo} />
        </div>
      </AssertionGate>
    </section>
  );
}

function ContextAssertion({
  context,
  locale,
  returnTo,
}: {
  context: QuotationContext;
  locale: string;
  returnTo: string;
}) {
  return (
    <li className="min-w-0 break-words">
      <span className="me-2 font-medium">{contextRole(context.kind, locale)}:</span>
      <AssertionGate spoiler={context.spoiler} locale={locale}>
        <div className="space-y-2" data-statement-id={context.statementId}>
          {context.status === 'current' && context.id && context.label ? (
            <a
              className={linkClass}
              href={`${subjectHref({ id: context.id, label: context.label }, locale).href}?${new URLSearchParams({ returnTo })}`}
            >
              {contextText(context, locale)}
            </a>
          ) : (
            contextText(context, locale)
          )}
          {context.status !== 'concealed' && context.status !== 'restricted' && (
            <>
              {context.assertion && (
                <Evidence
                  qualifiers={context.qualifiers ?? []}
                  references={context.references ?? []}
                  locale={locale}
                  returnTo={returnTo}
                />
              )}
              <Inspection assertion={context.assertion} locale={locale} returnTo={returnTo} />
            </>
          )}
        </div>
      </AssertionGate>
    </li>
  );
}

function SelectedText({
  selected,
  locale,
  returnTo,
  chosen,
  choose,
}: {
  selected: QuotationRow;
  locale: string;
  returnTo: string;
  chosen?: string | undefined;
  choose: (id?: string) => void;
}) {
  const o = option(locale);
  const text =
    selected.statements.find((text) => text.statementId === chosen) ??
    selected.statements.find((text) => text.language === locale) ??
    selected.statements[0];
  return (
    <>
      {selected.statements.length > 1 && (
        <label className="block space-y-2">
          <span>{m.quotation_language({}, o)}</span>
          <select
            className="block min-h-11 max-w-full rounded border bg-background p-2"
            value={text?.statementId ?? ''}
            onChange={(event) => choose(event.target.value)}
          >
            {selected.statements.map((statement, index) => (
              <option key={statement.statementId ?? index} value={statement.statementId ?? ''}>
                {m.quotation_language_choice(
                  {
                    number: index + 1,
                    language: statement.language
                      ? (languageName(statement.language, locale) ?? statement.language)
                      : m.quotation_unknown_context({}, o),
                  },
                  o,
                )}
              </option>
            ))}
          </select>
        </label>
      )}
      {text && (
        <QuotationStatement key={text.statementId ?? text.property} text={text} locale={locale} returnTo={returnTo} />
      )}
    </>
  );
}

function QuotationVisitView({
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
  const visit = useQuotationVisit({ id, locale, quote, returnTo, transport, initial });
  const { read, error, loading, selectedRef } = visit;
  const title = pickText(read?.public.subject.labels ?? {}, locale);
  const factsHref = subjectHref({ id, label: title.text }, locale).href;
  const origin = visit.safeOrigin ?? factsHref;
  const selected = read?.selected;

  return (
    <article className="mx-auto w-full min-w-0 max-w-4xl space-y-6 [overflow-wrap:anywhere]" aria-busy={loading}>
      <ViewHeading label={m.quotation_title({}, o)} headingClassName="font-sans" />
      <p className="max-w-prose text-muted-foreground">{m.quotation_intro({}, o)}</p>
      {loading && <p role="status">{m.quotation_loading({}, o)}</p>}
      {error && (
        <p role="alert">
          {error.reason === 'denied'
            ? m.quotation_denied({}, o)
            : error.reason === 'stale'
              ? m.quotation_stale({}, o)
              : m.quotation_unavailable({}, o)}
        </p>
      )}
      {error && (
        <div className="flex flex-wrap gap-3">
          {error.reason === 'unavailable' && (
            <Button className={actionClass} onClick={() => void visit.retry()}>
              {m.quotation_retry({}, o)}
            </Button>
          )}
          <Button variant="outline" className={actionClass} onClick={() => void visit.restart()}>
            {m.quotation_restart({}, o)}
          </Button>
        </div>
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
                  <li key={`${row.id}:${index}`}>
                    <Button
                      type="button"
                      variant={selected?.id === row.id ? 'default' : 'outline'}
                      className={actionClass}
                      aria-pressed={selected?.id === row.id}
                      disabled={loading}
                      onClick={() => void visit.select(row.id)}
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
              onClick={() => void visit.more()}
            >
              {m.quotation_more({}, o)}
            </Button>
          )}
          <div className="flex flex-wrap gap-3">
            {visit.hasPrevious && (
              <Button variant="outline" className={actionClass} onClick={() => void visit.previous()}>
                {m.quotation_previous({}, o)}
              </Button>
            )}
            <Button variant="outline" className={actionClass} onClick={() => void visit.refresh()}>
              {m.quotation_refresh({}, o)}
            </Button>
            <Button variant="outline" className={actionClass} onClick={() => void visit.restart()}>
              {m.quotation_restart({}, o)}
            </Button>
          </div>
          {selected && (
            <section
              key={`${visit.observation}:${selected.id}:${selected.observation}`}
              onClickCapture={visit.depart}
              onAuxClickCapture={visit.depart}
              aria-label={m.quotation_text({}, o)}
              className="min-w-0 space-y-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              data-quotation-id={selected.id}
              data-source-observation={selected.observation}
            >
              <h2 ref={selectedRef} tabIndex={-1} className="font-semibold">
                {m.quotation_selected({ id: String(read.rows.findIndex((row) => row.id === selected.id) + 1) }, o)}
              </h2>
              {selected.statements.length === 0 && <p role="status">{m.quotation_unavailable({}, o)}</p>}
              {selected.statements.some((text) => text.status === 'unavailable') && (
                <Button className={actionClass} onClick={() => void visit.refresh()}>
                  {m.quotation_retry({}, o)}
                </Button>
              )}
              <SelectedText
                selected={selected}
                locale={locale}
                returnTo={visit.returnHref}
                chosen={visit.text}
                choose={visit.chooseText}
              />
              <ul className="space-y-2">
                {selected.contexts.map((context, index) => (
                  <ContextAssertion
                    key={`${context.kind}:${context.statementId ?? index}:${context.property ?? ''}`}
                    context={context}
                    locale={locale}
                    returnTo={visit.returnHref}
                  />
                ))}
              </ul>
              {correctionControl(read, selected, locale, visit.returnHref, title.text)}
            </section>
          )}
        </div>
      )}
      {
        <nav aria-label={m.quotation_return({}, o)} className="flex flex-wrap gap-3">
          <a className={linkClass} href={origin}>
            {m.quotation_return({}, o)}
          </a>
          {(!read || !read.admitted) && (
            <a className={linkClass} href={factsHref}>
              {m.quotation_facts({}, o)}
            </a>
          )}
        </nav>
      }
    </article>
  );
}

export function QuotationView(props: Parameters<typeof QuotationVisitView>[0]) {
  const source = useRef({ initial: props.initial, generation: 0 });
  if (source.current.initial !== props.initial)
    source.current = { initial: props.initial, generation: source.current.generation + 1 };
  return <QuotationVisitView key={`${props.id}:${props.locale}:${source.current.generation}`} {...props} />;
}
