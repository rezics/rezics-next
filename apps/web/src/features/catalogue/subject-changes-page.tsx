import { useEffect, useReducer, useRef } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { PageHeading } from '../../shell/page-heading';
import { SubjectFrame } from '../pages/subject-frame';
import { viewTabLabels } from '../pages/route-support';
import { languageName } from '../../subject/language';
import { m } from '../../paraglide/messages.js';
import {
  changesState,
  type ChangeDetail,
  type ChangesFailure,
  type ChangesState,
  type ChangesTransport,
} from './subject-changes';

type Props = {
  state: ChangesState;
  locale: string;
  currentHref?: string;
  onMore?: () => void;
  onSelect?: (revision: number) => void;
  onRetry?: () => void;
  onDetailRetry?: () => void;
};
function Failure({ failure, locale }: { failure: ChangesFailure; locale: string }) {
  const o = { locale: locale as never };
  return (
    <p role="alert">
      {failure.kind === 'missing'
        ? m.changes_missing({}, o)
        : failure.kind === 'denied'
          ? m.changes_denied({}, o)
          : failure.kind === 'invalid'
            ? m.changes_invalid({}, o)
            : failure.kind === 'conflict'
              ? m.changes_conflict({}, o)
              : m.changes_unavailable({}, o)}
    </p>
  );
}
function revisionKind(kind: string, locale: string) {
  const o = { locale: locale as never };
  return kind === 'propose'
    ? m.changes_proposal({}, o)
    : kind === 'accept'
      ? m.changes_acceptance({}, o)
      : kind === 'reject'
        ? m.changes_rejection({}, o)
        : kind === 'adopt'
          ? m.changes_adoption({}, o)
          : m.changes_recorded({}, o);
}
function Explanation({ detail, locale }: { detail: ChangeDetail; locale: string }) {
  const o = { locale: locale as never };
  const summary = detail.summary;
  const field = (kind: 'label' | 'description' | 'alias') =>
    kind === 'label'
      ? m.changes_name({}, o)
      : kind === 'description'
        ? m.changes_description({}, o)
        : m.changes_aliases({}, o);
  return (
    <div className="min-w-0 space-y-3">
      <p>
        {summary.kind === 'limited'
          ? m.changes_limited({}, o)
          : summary.kind === 'terms'
            ? m.changes_terms({}, o)
            : summary.kind === 'candidate'
              ? m.changes_proposal_detail({}, o)
              : summary.kind === 'decision'
                ? summary.decision === 'accept'
                  ? m.changes_accepted_detail({}, o)
                  : m.changes_rejected_detail({}, o)
                : m.changes_adopted_detail({}, o)}
      </p>
      {summary.kind === 'terms' && (
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-muted-foreground">{m.changes_fields({}, o)}</dt>
            <dd>{summary.fields.map(field).join(' · ')}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{m.changes_languages({}, o)}</dt>
            <dd>
              {summary.languages
                .map((tag) => languageName(tag, locale) ?? m.subject_value_unlabelled({}, o))
                .join(' · ')}
            </dd>
          </div>
        </dl>
      )}
      {detail.propertyLabel?.text && (
        <p lang={detail.propertyLabel.lang} className="font-medium">
          {detail.propertyLabel.text}
        </p>
      )}
    </div>
  );
}

/** Shared subject frame and controls; no historical payload, actor or raw identifier is rendered. */
export function SubjectChangesPage({ state, locale, currentHref, onMore, onSelect, onRetry, onDetailRetry }: Props) {
  const o = { locale: locale as never };
  const busy = !!state.loading;
  const page = state.page;
  return (
    <article data-slot="subject-changes" className="flex min-w-0 flex-col gap-8" aria-busy={busy}>
      {page && (
        <SubjectFrame
          frame={{ id: page.id, title: page.title, type: '', summary: null }}
          locale={locale}
          unlabelled={m.subject_value_unlabelled({}, o)}
          typeLabel={page.typeLabel.text}
          tabs={[]}
          tabLabels={viewTabLabels()}
          view="details"
          navigation={
            <nav aria-label={m.changes_title({}, o)} className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <a className="underline underline-offset-4" href={page.href}>
                {m.changes_current({}, o)}
              </a>
              <span aria-current="page" className="font-medium">
                {m.changes_title({}, o)}
              </span>
            </nav>
          }
        />
      )}
      <header className="space-y-2">
        <PageHeading className="font-sans max-sm:text-3xl">
          {m.changes_title({}, o)}
        </PageHeading>
        <p className="max-w-prose text-sm text-muted-foreground">{m.changes_intro({}, o)}</p>
      </header>
      {!page && currentHref && (
        <a className="text-sm text-primary underline underline-offset-4" href={currentHref}>
          {m.changes_current({}, o)}
        </a>
      )}
      {state.loading === 'list' && <p role="status">{m.changes_loading({}, o)}</p>}
      {state.failure && (
        <div className="space-y-3">
          <Failure failure={state.failure} locale={locale} />
          {state.failure.kind !== 'missing' && onRetry && (
            <Button variant="outline" disabled={busy} onClick={onRetry}>
              {m.changes_retry({}, o)}
            </Button>
          )}
        </div>
      )}
      {page && (
        <div className="grid min-w-0 gap-8 md:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)]">
          <section className="min-w-0 space-y-4" aria-label={m.changes_revisions({}, o)}>
            <h2 className="text-xl font-semibold">{m.changes_revisions({}, o)}</h2>
            {!page.revisions.length && (
              <p className="text-muted-foreground">
                {page.next === null ? m.changes_empty({}, o) : m.changes_empty_page({}, o)}
              </p>
            )}
            <ol className="space-y-2">
              {page.revisions.map((row) => (
                <li key={row.revision}>
                  <Button
                    variant={state.selected === row.revision ? 'secondary' : 'ghost'}
                    className="h-auto w-full min-w-0 justify-start whitespace-normal py-3 text-start"
                    aria-pressed={state.selected === row.revision}
                    disabled={busy || !onSelect}
                    onClick={() => onSelect?.(row.revision)}
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <span>{m.changes_revision({ revision: String(row.revision) }, o)}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {revisionKind(row.kind, locale)}
                      </span>
                    </span>
                  </Button>
                </li>
              ))}
            </ol>
            {page.next !== null && onMore && (
              <Button variant="outline" disabled={busy} onClick={onMore}>
                {m.changes_more({}, o)}
              </Button>
            )}
            {state.loading === 'more' && <p role="status">{m.changes_loading({}, o)}</p>}
          </section>
          {!!page.revisions.length && (
            <section
              aria-labelledby="change-explanation-title"
              className="min-w-0 space-y-4 border-t border-border pt-5 md:border-s md:border-t-0 md:ps-6 md:pt-0"
            >
              <h2 id="change-explanation-title" className="text-xl font-semibold">
                {state.selected
                  ? m.changes_revision({ revision: String(state.selected) }, o)
                  : m.changes_explanation({}, o)}
              </h2>
              {state.selected === undefined && <p className="text-muted-foreground">{m.changes_choose({}, o)}</p>}
              {state.loading === 'detail' && <p role="status">{m.changes_detail_loading({}, o)}</p>}
              {state.detail?.kind === 'ready' && <Explanation detail={state.detail.detail} locale={locale} />}
              {state.detail && state.detail.kind !== 'ready' && (
                <div className="space-y-3">
                  <Failure failure={state.detail} locale={locale} />
                  {onDetailRetry && (
                    <Button variant="outline" disabled={busy} onClick={onDetailRetry}>
                      {m.changes_retry_detail({}, o)}
                    </Button>
                  )}
                </div>
              )}
              {state.selected !== undefined && (
                <p className="text-sm text-muted-foreground">{m.changes_current_notice({}, o)}</p>
              )}
            </section>
          )}
        </div>
      )}
    </article>
  );
}

/** Instance state is destroyed when identity/session changes. It never enters SSR or a query cache. */
export function SubjectChanges({
  locale,
  transport,
  currentHref,
}: {
  locale: string;
  transport: ChangesTransport;
  currentHref?: string;
}) {
  const [state, dispatch] = useReducer(changesState, { loading: 'list' });
  const session = useRef<string | undefined>(undefined);
  const running = useRef(false);
  const mounted = useRef(false);
  const retryCursor = useRef<string | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    running.current = true;
    void transport
      .list()
      .catch(() => ({ kind: 'unavailable' as const }))
      .then((result) => {
        if (cancelled) return;
        if (result.kind === 'ready') session.current = result.session;
        dispatch({ type: 'list', result, more: false });
        running.current = false;
      });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [transport]);
  async function load(cursor?: string) {
    if (running.current) return;
    running.current = true;
    retryCursor.current = cursor;
    dispatch({ type: 'list-start', more: cursor !== undefined });
    const result = await transport.list(cursor, session.current).catch(() => ({ kind: 'unavailable' as const }));
    if (!mounted.current) return;
    if (result.kind === 'ready') session.current = result.session ?? session.current;
    dispatch({ type: 'list', result, more: cursor !== undefined });
    running.current = false;
  }
  async function select(revision: number) {
    if (running.current) return;
    running.current = true;
    dispatch({ type: 'detail-start', revision });
    const result = await transport.detail(revision, session.current).catch(() => ({ kind: 'unavailable' as const }));
    if (!mounted.current) return;
    if (result.kind === 'ready') session.current = result.session ?? session.current;
    dispatch({ type: 'detail', result });
    running.current = false;
  }
  return (
    <SubjectChangesPage
      state={state}
      locale={locale}
      {...(currentHref ? { currentHref } : {})}
      onMore={() => {
        if (state.page?.next !== null && state.page?.next !== undefined) void load(state.page.next);
      }}
      onRetry={() => {
        void load(retryCursor.current);
      }}
      onSelect={(revision) => {
        void select(revision);
      }}
      onDetailRetry={() => {
        if (state.selected !== undefined) void select(state.selected);
      }}
    />
  );
}
