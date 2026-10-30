import { useEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { CandidateValue } from '../pages/data';
import { ViewHeading } from '../pages/subject-frame';
import type { Snak } from '../pages/shared';
import { candidateContext } from '../../subject/candidates';
import { m } from '../../paraglide/messages.js';
import type { ValuePage, ValueRead, ValueTransport } from './value-explanation';

function Part({ snak, page, locale }: { snak: Snak; page: ValuePage; locale: string }) {
  const label = page.labels[snak.property.id];
  return (
    <div className="min-w-0 space-y-1 break-words">
      <p lang={label?.lang} className="text-sm text-muted-foreground">
        {label?.text || m.subject_value_unlabelled({}, { locale: locale as never })}
      </p>
      <CandidateValue snak={snak} related={page.related} locale={locale} />
    </div>
  );
}

/** Read-only explanation of one native selected statement, using the ordinary value renderer. */
export function ValueExplanationPage({
  result,
  locale,
  busy = false,
  onMore,
  onReload,
}: {
  result?: ValueRead | undefined;
  locale: string;
  busy?: boolean;
  onMore?: (cursor: string) => void;
  onReload?: () => void;
}) {
  const o = { locale: locale as never };
  const page = result?.kind === 'ready' ? result.page : undefined;
  const statement = page?.statement;
  const competition = page?.competition;
  const change = page?.change;
  return (
    <article
      className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6"
      aria-busy={busy}
      data-slot="value-explanation"
    >
      {page && (
        <div className="space-y-2 border-b border-border pb-5">
          <a
            href={page.href}
            lang={page.title.lang}
            className="text-xl font-semibold underline-offset-4 hover:underline"
          >
            {page.title.text || m.subject_value_unlabelled({}, o)}
          </a>
          {page.typeLabel.text && (
            <p lang={page.typeLabel.lang} className="text-sm text-muted-foreground">
              {page.typeLabel.text}
            </p>
          )}
        </div>
      )}
      <ViewHeading label={m.value_why({}, o)} headingClassName="font-sans" />
      {!result ? (
        <p role="status">{m.candidate_loading({}, o)}</p>
      ) : result.kind !== 'ready' ? (
        <p role="alert">
          {result.kind === 'denied'
            ? m.value_denied({}, o)
            : result.kind === 'missing'
              ? m.value_missing({}, o)
              : result.kind === 'invalid'
                ? m.value_invalid({}, o)
                : m.value_error({}, o)}
        </p>
      ) : null}
      {page && (
        <>
          <nav
            aria-label={m.value_why({}, o)}
            className="flex flex-wrap gap-x-5 gap-y-3 text-sm text-primary [&_a]:underline [&_a]:underline-offset-4"
          >
            <a href={page.href}>{m.changes_current({}, o)}</a>
            <a href={`${page.href}/sources`}>{m.subject_sources({}, o)}</a>
            <a href={`${page.href}/changes`}>{m.changes_title({}, o)}</a>
            {page.reviewHref && <a href={page.reviewHref}>{m.sources_compare({}, o)}</a>}
          </nav>
          <p className="text-sm text-muted-foreground">{m.value_basis({}, o)}</p>
          <dl className="space-y-3 rounded-xl border border-border bg-card p-4 text-sm">
            <div>
              <dt className="text-muted-foreground">{m.context_title({}, o)}</dt>
              <dd>{page.context === candidateContext ? m.context_global({}, o) : m.context_unnamed({}, o)}</dd>
            </div>
            {statement && (
              <>
                <div>
                  <dt className="text-muted-foreground">{m.candidate_rank({}, o)}</dt>
                  <dd>
                    {statement.rank === 'preferred'
                      ? m.candidate_rank_preferred({}, o)
                      : m.candidate_rank_normal({}, o)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{m.value_proposal_revision({}, o)}</dt>
                  <dd>{m.changes_revision({ revision: String(statement.rezics.revision) }, o)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{m.value_proposal_release({}, o)}</dt>
                  <dd className="break-all font-mono text-xs">{statement.rezics.release}</dd>
                </div>
              </>
            )}
          </dl>
          {statement ? (
            <>
              <section className="space-y-3" aria-labelledby="value-selected">
                <h2 id="value-selected" lang={page.propertyLabel.lang} className="text-xl font-semibold">
                  {page.propertyLabel.text || m.subject_value_unlabelled({}, o)}
                </h2>
                <div className="min-w-0 break-words rounded-xl bg-muted/50 p-4 text-lg">
                  <CandidateValue
                    snak={statement}
                    related={page.related}
                    subject={page.id}
                    documents={page.documents}
                    locale={locale}
                  />
                </div>
                {!!statement.qualifiers.length && (
                  <dl className="space-y-3">
                    <dt className="font-medium">{m.value_qualifiers({}, o)}</dt>
                    <dd className="space-y-3">
                      {statement.qualifiers.map((part, index) => (
                        <Part key={index} snak={part} page={page} locale={locale} />
                      ))}
                    </dd>
                  </dl>
                )}
              </section>
              <section className="space-y-3" aria-labelledby="value-citations">
                <h2 id="value-citations" className="text-xl font-semibold">
                  {m.sources_citations({}, o)}
                </h2>
                {statement.references.length ? (
                  <ol className="list-decimal space-y-4 ps-5">
                    {statement.references.map((reference, index) => (
                      <li key={index} className="space-y-2">
                        {reference.parts.length
                          ? reference.parts.map((part, partIndex) => (
                              <Part key={partIndex} snak={part} page={page} locale={locale} />
                            ))
                          : m.value_reference_unavailable({}, o)}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>{m.sources_no_citations({}, o)}</p>
                )}
                <p className="text-sm text-muted-foreground">{m.value_citation_scope({}, o)}</p>
              </section>
              <section className="space-y-3 border-t border-border pt-5" aria-labelledby="value-decision">
                <h2 id="value-decision" className="text-xl font-semibold">
                  {m.value_decision({}, o)}
                </h2>
                <p>
                  {competition?.kind === 'returned'
                    ? competition.decision === 'accepted'
                      ? m.value_accepted({}, o)
                      : competition.decision === 'rejected'
                        ? m.candidate_rejected_state({}, o)
                        : m.candidate_unresolved({}, o)
                    : competition?.kind === 'denied'
                      ? m.value_metadata_denied({}, o)
                      : competition?.kind === 'not-returned'
                        ? m.value_not_returned({}, o)
                        : m.value_metadata_unavailable({}, o)}
                </p>
                {competition?.kind === 'returned' && (
                  <>
                    <p className="text-sm">
                      {m.value_candidate_revision({ revision: String(competition.revision) }, o)}
                    </p>
                    <p className="break-all font-mono text-xs">{competition.release}</p>
                    <p>
                      {competition.adoption === 'inherit'
                        ? m.context_inherited({}, o)
                        : competition.adoption === 'replace'
                          ? m.context_replaced({}, o)
                          : competition.adoption === 'suppress'
                            ? m.context_suppressed({}, o)
                            : m.value_adoption_unavailable({}, o)}
                    </p>
                  </>
                )}
                {competition?.kind === 'not-returned' && competition.next !== null && onMore && (
                  <Button variant="outline" disabled={busy} onClick={() => onMore(competition.next!)}>
                    {m.value_more({}, o)}
                  </Button>
                )}
                <p className="text-sm text-muted-foreground">{m.value_page_bound({}, o)}</p>
              </section>
              <section className="space-y-2" aria-labelledby="value-change">
                <h2 id="value-change" className="text-xl font-semibold">
                  {m.value_change({}, o)}
                </h2>
                <p>
                  {change?.kind === 'ready'
                    ? change.detail.summary.kind === 'limited'
                      ? m.changes_limited({}, o)
                      : change.detail.summary.kind === 'candidate'
                        ? m.changes_proposal_detail({}, o)
                        : change.detail.summary.kind === 'decision'
                          ? change.detail.summary.decision === 'accept'
                            ? m.changes_accepted_detail({}, o)
                            : m.changes_rejected_detail({}, o)
                          : m.changes_adopted_detail({}, o)
                    : change?.kind === 'denied'
                      ? m.value_metadata_denied({}, o)
                      : m.value_change_unavailable({}, o)}
                </p>
              </section>
            </>
          ) : (
            <p role="status">
              {page.absence === 'unresolved'
                ? m.context_unresolved({}, o)
                : page.absence === 'suppressed'
                  ? m.context_suppressed({}, o)
                  : page.absence === 'withheld'
                    ? m.value_withheld({}, o)
                    : m.value_not_selected({}, o)}
            </p>
          )}
        </>
      )}
      {onReload && (
        <div>
          <Button variant="outline" disabled={busy} onClick={onReload}>
            {m.candidate_reload({}, o)}
          </Button>
        </div>
      )}
    </article>
  );
}

/** Ephemeral state is discarded before a fresh read; private competition never enters a shared query cache. */
export function ValueExplanation({
  transport,
  locale,
  initial,
}: {
  transport: ValueTransport;
  locale: string;
  initial?: ValueRead;
}) {
  const [result, setResult] = useState<ValueRead | undefined>(initial);
  const [busy, setBusy] = useState(false);
  const session = useRef<string | undefined>(initial?.kind === 'ready' ? initial.session : undefined);
  const running = useRef(false);
  const generation = useRef(0);
  async function load(cursor?: string) {
    if (running.current) return;
    running.current = true;
    const version = ++generation.current;
    setBusy(true);
    setResult(undefined);
    const next = await transport(cursor, session.current).catch((): ValueRead => ({ kind: 'unavailable' }));
    if (version !== generation.current) return;
    session.current = next.kind === 'ready' ? next.session : undefined;
    setResult(next);
    setBusy(false);
    running.current = false;
  }
  useEffect(() => {
    if (initial) return;
    void load();
    return () => {
      generation.current++;
      running.current = false;
    };
  }, [transport]);
  return (
    <ValueExplanationPage
      result={result}
      locale={locale}
      busy={busy}
      onMore={(cursor) => void load(cursor)}
      onReload={() => void load()}
    />
  );
}
