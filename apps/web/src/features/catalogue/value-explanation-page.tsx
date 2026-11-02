import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { CandidateValue } from '../pages/data';
import { ViewHeading } from '../pages/subject-frame';
import type { Snak } from '../pages/shared';
import { candidateContext } from '../../subject/candidates';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { m } from '../../paraglide/messages.js';
import type { ValuePage, ValueRead, ValueTransport } from './value-explanation';
import { ChangeExplanation } from './subject-changes-page';

type ValueActionKind = 'more' | 'retry' | 'reload';
type ValueAction = { kind: ValueActionKind; source: HTMLButtonElement; keyboard: boolean; token?: number };
type ValueActionResult = { token: number; reading: unknown; result: ValueRead };
type PendingValueAction = ValueAction & { token: number; document: Document; retired: boolean; cancel: () => void };

const useFocusLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

function Part({ snak, page, locale }: { snak: Snak; page: ValuePage; locale: string }) {
  const label = page.labels[snak.property.id];
  return (
    <div className="min-w-0 max-w-full space-y-1 whitespace-normal [overflow-wrap:anywhere]">
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
  onRetry,
  reloadFromFirstPage = false,
  actionResult,
  reading,
  isCurrent = () => true,
}: {
  result?: ValueRead | undefined;
  locale: string;
  busy?: boolean;
  onMore?: (cursor: string, action: ValueAction) => void;
  onReload?: (action: ValueAction) => void;
  onRetry?: ((action: ValueAction) => void) | undefined;
  reloadFromFirstPage?: boolean;
  actionResult?: ValueActionResult | undefined;
  reading?: unknown;
  isCurrent?: () => boolean;
}) {
  const headingId = useId();
  const explanationHeading = useRef<HTMLHeadingElement>(null);
  const pendingAction = useRef<PendingValueAction | null>(null);
  function clearPendingAction() {
    pendingAction.current?.cancel();
  }
  function actionIsMeaningful(action: PendingValueAction) {
    const source = action.source;
    return (
      !action.retired &&
      source.isConnected &&
      source.dataset.valueAction === action.kind &&
      !source.matches(':disabled') &&
      !source.closest('[hidden], [inert], [aria-hidden="true"]')
    );
  }
  function beginAction(action: ValueAction, token: number | undefined) {
    clearPendingAction();
    if (!action.keyboard || token === undefined) return;
    const document = action.source.ownerDocument;
    const request: PendingValueAction = {
      ...action,
      token,
      document,
      retired: false,
      cancel() {
        document.removeEventListener('focusin', moved, true);
        document.removeEventListener('pointerdown', cancel, true);
        document.removeEventListener('keydown', tabbed, true);
        document.defaultView?.removeEventListener('blur', cancel);
        if (pendingAction.current === request) pendingAction.current = null;
      },
    };
    function moved(event: FocusEvent) {
      const target = event.target;
      if (target === action.source) return;
      if (
        (target === document.body || target === document.documentElement) &&
        (!action.source.isConnected || action.source.matches(':disabled'))
      )
        return;
      request.cancel();
    }
    function cancel() {
      request.cancel();
    }
    function tabbed(event: KeyboardEvent) {
      if (event.key === 'Tab') request.cancel();
    }
    document.addEventListener('focusin', moved, true);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', tabbed, true);
    document.defaultView?.addEventListener('blur', cancel);
    pendingAction.current = request;
  }
  useEffect(() => () => clearPendingAction(), []);
  useFocusLayoutEffect(() => {
    const action = pendingAction.current;
    if (action && (!action.source.isConnected || action.source.dataset.valueAction !== action.kind)) {
      action.retired = true;
    }
  }, [busy, result, onMore, onReload, onRetry]);
  const o = { locale: locale as never };
  const page = result?.kind === 'ready' ? result.page : undefined;
  const statement = page?.statement;
  const competition = page?.competition;
  const change = page?.change;
  useFocusLayoutEffect(() => {
    const action = pendingAction.current;
    if (
      !action ||
      busy ||
      !actionResult ||
      actionResult?.token !== action.token ||
      actionResult.result !== result ||
      actionResult.reading !== reading
    )
      return;
    if (!isCurrent()) {
      action.cancel();
      return;
    }
    const active = action.document.activeElement;
    if (active !== action.source && active !== action.document.body && active !== action.document.documentElement) {
      action.cancel();
      return;
    }
    if (actionIsMeaningful(action)) {
      if (active !== action.source) action.source.focus();
    } else {
      explanationHeading.current?.focus();
    }
    action.cancel();
  }, [actionResult, busy, isCurrent, reading, result]);

  function activate(
    event: MouseEvent<HTMLButtonElement>,
    kind: ValueActionKind,
    run: (action: ValueAction) => void,
  ) {
    const source = event.currentTarget;
    const action = {
      kind,
      source,
      keyboard: event.detail === 0 && source.ownerDocument.activeElement === source,
    } satisfies ValueAction;
    run(action);
    beginAction(action, action.token);
  }
  return (
    <article
      className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6 whitespace-normal [overflow-wrap:anywhere] [&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:items-center [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring [&_pre]:max-w-full [&_pre]:whitespace-pre-wrap"
      aria-busy={busy}
      data-slot="value-explanation"
    >
      {page && (
        <div className="space-y-2 border-b border-border pb-5">
          <a
            href={page.href}
            lang={page.title.lang}
            className="inline-flex min-h-11 min-w-11 max-w-full items-center text-xl font-semibold underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
      <ViewHeading
        label={m.value_why({}, o)}
        headingRef={explanationHeading}
        headingTabIndex={actionResult ? -1 : undefined}
        headingClassName="font-sans focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      />
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
            className="flex min-w-0 flex-wrap gap-x-5 gap-y-3 text-sm text-primary [&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:items-center [&_a]:underline [&_a]:underline-offset-4 [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring"
          >
            <a href={page.href}>{m.changes_current({}, o)}</a>
            <a href={`${page.href}/sources`}>{m.subject_sources({}, o)}</a>
            <a href={`${page.href}/changes`}>{m.changes_title({}, o)}</a>
            {page.reviewHref && <a href={page.reviewHref}>{m.sources_compare({}, o)}</a>}
          </nav>
          {statement ? (
            <>
              <section className="min-w-0" aria-labelledby={`${headingId}-selected`}>
                <ContentItemFrame as="div" className="min-w-0 space-y-4 p-4 sm:p-5">
                  <ContentItemHeading
                    id={`${headingId}-selected`}
                    lang={page.propertyLabel.lang}
                    className="text-xl leading-snug font-semibold"
                  >
                    {page.propertyLabel.text || m.subject_value_unlabelled({}, o)}
                  </ContentItemHeading>
                  <div data-content-item-slot="preview" className="min-w-0 text-lg leading-relaxed">
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
                </ContentItemFrame>
              </section>
              <section className="min-w-0 space-y-4" aria-labelledby={`${headingId}-citations`}>
                <ContentItemHeading id={`${headingId}-citations`} className="text-xl leading-snug font-semibold">
                  {m.sources_citations({}, o)}
                </ContentItemHeading>
                {statement.references.length ? (
                  <ol className="min-w-0 list-decimal space-y-4 ps-5">
                    {statement.references.map((reference, index) => (
                      <li key={index} className="min-w-0 ps-1">
                        <ContentItemFrame as="div" className="min-w-0 space-y-3 p-3 sm:p-4">
                          {reference.parts.length
                            ? reference.parts.map((part, partIndex) => (
                                <Part key={partIndex} snak={part} page={page} locale={locale} />
                              ))
                            : m.value_reference_unavailable({}, o)}
                        </ContentItemFrame>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>{m.sources_no_citations({}, o)}</p>
                )}
                <p className="text-sm text-muted-foreground">{m.value_citation_scope({}, o)}</p>
              </section>
              <section className="min-w-0 border-t border-border pt-5" aria-labelledby={`${headingId}-decision`}>
                <ContentItemFrame as="div" className="min-w-0 space-y-4 p-4 sm:p-5">
                  <ContentItemHeading id={`${headingId}-decision`} className="text-xl leading-snug font-semibold">
                    {m.value_decision({}, o)}
                  </ContentItemHeading>
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
                  <dl className="space-y-3 text-sm">
                    <div>
                      <dt className="text-muted-foreground">{m.context_title({}, o)}</dt>
                      <dd>{page.context === candidateContext ? m.context_global({}, o) : m.context_unnamed({}, o)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{m.candidate_rank({}, o)}</dt>
                      <dd>
                        {statement.rank === 'preferred'
                          ? m.candidate_rank_preferred({}, o)
                          : m.candidate_rank_normal({}, o)}
                      </dd>
                    </div>
                  </dl>
                  {competition?.kind === 'returned' && (
                    <p>
                      {competition.adoption === 'inherit'
                        ? m.context_inherited({}, o)
                        : competition.adoption === 'replace'
                          ? m.context_replaced({}, o)
                          : competition.adoption === 'suppress'
                            ? m.context_suppressed({}, o)
                            : m.value_adoption_unavailable({}, o)}
                    </p>
                  )}
                  {competition?.kind === 'not-returned' && (
                    <p className="text-sm text-muted-foreground">{m.value_page_bound({}, o)}</p>
                  )}
                  {competition?.kind === 'not-returned' && competition.next !== null && onMore && (
                    <Button
                      variant="outline"
                      className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere]"
                      disabled={busy}
                      data-value-action="more"
                      onClick={(event) => activate(event, 'more', (action) => onMore(competition.next!, action))}
                    >
                      {m.value_more({}, o)}
                    </Button>
                  )}
                </ContentItemFrame>
              </section>
              <section className="min-w-0 space-y-3" aria-labelledby={`${headingId}-change`}>
                <ContentItemHeading id={`${headingId}-change`} className="text-xl leading-snug font-semibold">
                  {m.value_change({}, o)}
                </ContentItemHeading>
                {change?.kind === 'ready' ? (
                  <ChangeExplanation detail={change.detail} locale={locale} />
                ) : (
                  <p>
                    {change?.kind === 'denied' ? m.value_metadata_denied({}, o) : m.value_change_unavailable({}, o)}
                  </p>
                )}
              </section>
            </>
          ) : (
            <div className="space-y-3">
              <p role="status">
                {page.absence === 'unresolved'
                  ? m.context_unresolved({}, o)
                  : page.absence === 'suppressed'
                    ? m.context_suppressed({}, o)
                    : page.absence === 'withheld'
                      ? m.value_withheld({}, o)
                      : m.value_not_selected({}, o)}
              </p>
              <p className="text-sm">
                {m.context_title({}, o)}:{' '}
                {page.context === candidateContext ? m.context_global({}, o) : m.context_unnamed({}, o)}
              </p>
            </div>
          )}
          <details className="min-w-0 rounded-xl border border-border p-4 text-sm">
            <summary className="min-h-11 cursor-pointer py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {m.catalogue_technical_details({}, o)}
            </summary>
            {statement && <p className="mt-4 text-muted-foreground">{m.value_basis({}, o)}</p>}
            <dl className="mt-4 space-y-3 [&_dd]:break-all [&_dd]:font-mono [&_dd]:text-xs">
              <div>
                <dt>{m.creator_editions_subject({}, o)}</dt>
                <dd>{page.id}</dd>
              </div>
              <div>
                <dt>{m.context_title({}, o)}</dt>
                <dd>{page.context}</dd>
              </div>
              {statement && (
                <>
                  <div>
                    <dt>{m.catalogue_statement_id({}, o)}</dt>
                    <dd>{statement.id}</dd>
                  </div>
                  <div>
                    <dt>{page.propertyLabel.text || m.subject_value_unlabelled({}, o)}</dt>
                    <dd>{statement.property.id}</dd>
                  </div>
                  <div>
                    <dt>{m.value_proposal_revision({}, o)}</dt>
                    <dd>{m.changes_revision({ revision: String(statement.rezics.revision) }, o)}</dd>
                  </div>
                  <div>
                    <dt>{m.value_proposal_release({}, o)}</dt>
                    <dd>{statement.rezics.release}</dd>
                  </div>
                </>
              )}
              {competition?.kind === 'returned' && (
                <>
                  <div>
                    <dt>{m.value_decision({}, o)}</dt>
                    <dd>{m.value_candidate_revision({ revision: String(competition.revision) }, o)}</dd>
                  </div>
                  <div>
                    <dt>{m.value_proposal_release({}, o)}</dt>
                    <dd>{competition.release}</dd>
                  </div>
                </>
              )}
            </dl>
          </details>
        </>
      )}
      {(onReload || onRetry) && (
        <div className="flex flex-wrap gap-3">
          {onRetry && (
            <Button
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere]"
              disabled={busy}
              data-value-action="retry"
              onClick={(event) => activate(event, 'retry', onRetry)}
            >
              {m.value_retry({}, o)}
            </Button>
          )}
          {onReload && (
            <Button
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere]"
              disabled={busy}
              data-value-action="reload"
              onClick={(event) => activate(event, 'reload', onReload)}
            >
              {reloadFromFirstPage ? m.value_restart({}, o) : m.candidate_reload({}, o)}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

type ReadingInputs = {
  transport: ValueTransport;
  locale: string;
  initial?: ValueRead;
  /** A loader refresh starts a new read even when the native address has not changed. */
  episode?: unknown;
};
type PageRequest = { cursor: string | undefined; session: string | undefined };

function unavailable(result: ValueRead | undefined) {
  return (
    result?.kind === 'unavailable' || (result?.kind === 'ready' && result.page.competition?.kind === 'unavailable')
  );
}

/** Replaced readings and viewer/session epochs discard every held page and recovery request. */
export function ValueExplanation({ transport, locale, initial, episode = initial }: ReadingInputs) {
  const [reading, setReading] = useState({ transport, locale, initial, episode, seed: initial, version: 0 });
  if (
    reading.transport !== transport ||
    reading.locale !== locale ||
    reading.initial !== initial ||
    reading.episode !== episode
  ) {
    setReading({
      transport,
      locale,
      initial,
      episode,
      // An unchanged initial result belongs to the retired reading, not the replacement read.
      seed: initial !== reading.initial ? initial : undefined,
      version: reading.version + 1,
    });
  }
  const work = useCatalogueLifetime(JSON.stringify(['value-explanation', locale, reading.version]));
  return <ValueEpisode key={work.generation} {...{ transport, locale, initial: reading.seed, work }} />;
}

/** Reads hide the old explanation; only an unavailable read retains its exact recovery request. */
function ValueEpisode({
  transport,
  locale,
  initial,
  work,
}: {
  transport: ValueTransport;
  locale: string;
  initial?: ValueRead | undefined;
  work: ReturnType<typeof useCatalogueLifetime>;
}) {
  const [result, setResult] = useState<ValueRead | undefined>(initial);
  const [busy, setBusy] = useState(false);
  const session = useRef<string | undefined>(initial?.kind === 'ready' ? initial.session : undefined);
  const [cursor, setCursor] = useState<string | undefined>();
  const [actionResult, setActionResult] = useState<ValueActionResult | undefined>();
  const [retry, setRetry] = useState<PageRequest | undefined>(() =>
    unavailable(initial) ? { cursor: undefined, session: session.current } : undefined,
  );
  const running = useRef(false);
  const generation = useRef(0);
  function load(
    request: PageRequest = { cursor: undefined, session: session.current },
    action?: ValueAction,
  ): void {
    if (!work.active() || running.current) return;
    running.current = true;
    const version = ++generation.current;
    if (action) action.token = version;
    setBusy(true);
    setResult(undefined);
    setRetry(undefined);
    setCursor(request.cursor);
    setActionResult(undefined);
    void (async () => {
      const next = await transport(request.cursor, request.session).catch((): ValueRead => ({ kind: 'unavailable' }));
      if (!work.active() || version !== generation.current) return;
      session.current = next.kind === 'ready' ? next.session : undefined;
      setRetry(
        unavailable(next)
          ? {
              cursor: request.cursor,
              session: next.kind === 'ready' ? next.session : request.session,
            }
          : undefined,
      );
      setResult(next);
      setBusy(false);
      running.current = false;
      if (action?.keyboard) setActionResult({ token: version, reading: work.generation, result: next });
    })();
  }
  useEffect(() => {
    if (!initial) void load();
    return () => {
      generation.current++;
      running.current = false;
      session.current = undefined;
    };
  }, [work]);
  // A saved control belongs to the result that offered it, including across manual reloads.
  const offered = generation.current;
  return (
    <ValueExplanationPage
      result={work.active() ? result : undefined}
      locale={locale}
      busy={busy}
      actionResult={actionResult}
      reading={work.generation}
      isCurrent={work.active}
      onMore={(cursor, action) => {
        if (offered === generation.current) load({ cursor, session: session.current }, action);
      }}
      onReload={(action) => {
        if (offered === generation.current) load(undefined, action);
      }}
      onRetry={
        retry
          ? (action) => {
              if (offered === generation.current) load(retry, action);
            }
          : undefined
      }
      reloadFromFirstPage={cursor !== undefined}
    />
  );
}
