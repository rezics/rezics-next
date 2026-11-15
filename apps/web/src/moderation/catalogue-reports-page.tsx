import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../paraglide/messages.js';
import { actOnCatalogueReport, type CatalogueReportCommand } from './catalogue-reports-actions';
import {
  CATALOGUE_REPORTS_LIMIT,
  loadCatalogueReports,
  loadCatalogueSubject,
  prepareCatalogueReportsRead,
  type CatalogueReport,
  catalogueReportsReadKey,
  type CatalogueReportsRead,
  type CatalogueReportsReader,
  type CatalogueSubjectReader,
} from './catalogue-reports-read';
import { createCatalogueReportsJourney, type CatalogueReportsPageState } from './catalogue-reports-journey';

const loading: CatalogueReportsPageState = { state: 'loading', reports: [], next: null };

export function catalogueReportsSearch(search: Record<string, unknown>): { cursor?: string } {
  return typeof search.cursor === 'string' ? { cursor: search.cursor } : {};
}

export type CatalogueReportsViewProps = {
  page: CatalogueReportsPageState;
  onSelect: (reportId: string) => void;
  onReason: (reason: string) => void;
  onAct: (action: 'dismiss' | 'hide' | 'restore') => void;
  onRetryAction: () => void;
  onRetryPage: () => void;
  onRetrySubject: () => void;
  onRefresh: () => void;
  onNext: (cursor: string) => void;
  onRestart: () => void;
};

function dateLabel(value: string) {
  return value
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/u, ' UTC')
    .replace(/Z$/u, ' UTC');
}

function outcomeLabel(report: CatalogueReport) {
  if (report.outcome === 'actioned') return m.moderation_actioned();
  if (report.outcome === 'dismissed') return m.moderation_dismissed();
  return null;
}

function actionLabel(action: 'dismiss' | 'hide' | 'restore') {
  if (action === 'dismiss') return m.moderation_dismiss();
  if (action === 'hide') return m.catalogue_reports_hide_subject();
  return m.catalogue_reports_restore_subject();
}

function reportVisibilityLabel(visibility: string): string {
  if (visibility === 'visible') return m.catalogue_reports_visibility_visible();
  if (visibility === 'hidden') return m.catalogue_reports_visibility_hidden();
  if (visibility === 'taken_down') return m.catalogue_reports_visibility_taken_down();
  return visibility;
}

export function CatalogueReportsView({
  page,
  onSelect,
  onReason,
  onAct,
  onRetryAction,
  onRetryPage,
  onRetrySubject,
  onRefresh,
  onNext,
  onRestart,
}: CatalogueReportsViewProps) {
  if (page.state !== 'loaded') {
    const content =
      page.state === 'loading' ? (
        <p role="status" className="mt-4 text-muted-foreground">
          {m.moderation_queue_loading()}
        </p>
      ) : page.state === 'denied' ? (
        <p role="status" className="mt-4 text-muted-foreground">
          {m.moderation_queue_read_denied()}
        </p>
      ) : page.state === 'stale' ? (
        <>
          <p role="alert" className="mt-4 text-muted-foreground">
            {m.moderation_queue_stale()}
          </p>
          <Button className="mt-4" onClick={onRestart}>
            {m.moderation_queue_restart()}
          </Button>
        </>
      ) : (
        <>
          <p role="alert" className="mt-4 text-muted-foreground">
            {m.report_unavailable()}
          </p>
          <Button className="mt-4" onClick={onRetryPage}>
            {m.moderation_queue_retry()}
          </Button>
        </>
      );
    return (
      <main
        className={`mx-auto w-full ${page.state === 'loading' ? 'max-w-6xl' : 'max-w-3xl'} px-4 py-6 sm:px-8 sm:py-10`}
      >
        <h1 className="text-2xl font-semibold">{m.moderation_reports_heading()}</h1>
        {content}
      </main>
    );
  }

  const selected = page.reports.find((report) => report.id === page.selectedId) ?? null;
  const locked = ['sending', 'uncertain', 'confirmed', 'failed'].includes(page.action.state);
  const canRestore =
    page.subject.state === 'unavailable' || (page.subject.state === 'changed' && page.subject.visibility !== 'visible');
  const failedText =
    page.action.state !== 'failed'
      ? null
      : page.action.reason === 'conflict'
        ? m.moderation_queue_conflict()
        : page.action.reason === 'forbidden' || page.action.reason === 'sign-in'
          ? m.moderation_queue_denied()
          : page.action.reason === 'unavailable'
            ? m.moderation_bulk_unavailable()
            : m.report_unavailable();

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-10" aria-labelledby="catalogue-reports-heading">
      <h1 id="catalogue-reports-heading" className="text-2xl font-semibold">
        {m.moderation_reports_heading()}
      </h1>
      {page.reports.length === 0 ? (
        <p className="mt-6 text-muted-foreground">
          {page.next ? m.moderation_queue_empty_next() : m.moderation_reports_empty()}
        </p>
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.6fr)]">
          <nav aria-label={m.moderation_reports_tab()} className="grid content-start gap-2">
            {page.reports.map((report) => (
              <Button
                key={report.id}
                type="button"
                variant={report.id === page.selectedId ? 'secondary' : 'outline'}
                aria-pressed={report.id === page.selectedId}
                onClick={() => onSelect(report.id)}
                className="grid h-auto min-h-7 w-full gap-1 whitespace-normal p-3 text-start"
              >
                <span className="font-medium">{report.target.id}</span>
                <span className="text-sm text-muted-foreground">
                  {dateLabel(report.createdAt)}
                  {outcomeLabel(report) ? ` · ${outcomeLabel(report)}` : ''}
                </span>
              </Button>
            ))}
            {page.next ? (
              <Button className="mt-2" variant="outline" onClick={() => onNext(page.next!)}>
                {m.threads_next_page()}
              </Button>
            ) : null}
          </nav>
          {selected ? (
            <div className="min-w-0 space-y-4">
              <article className="min-w-0 rounded-2xl border p-4 sm:p-6" aria-label={m.moderation_queue_submission()}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold">{m.moderation_queue_submission()}</h2>
                    <p className="mt-1 break-all text-sm text-muted-foreground">{selected.id}</p>
                  </div>
                  {outcomeLabel(selected) ? <span className="text-sm font-medium">{outcomeLabel(selected)}</span> : null}
                </div>
                <dl className="mt-5 grid gap-3 text-sm">
                  <div>
                    <dt className="font-medium">{m.moderation_reason_label()}</dt>
                    <dd className="mt-1">{selected.reason}</dd>
                  </div>
                  {selected.evidence ? (
                    <div>
                      <dt className="font-medium">{m.moderation_queue_submission()}</dt>
                      <dd className="mt-1 whitespace-pre-wrap break-words">{selected.evidence}</dd>
                    </div>
                  ) : null}
                </dl>
                <section className="mt-6 rounded-xl bg-muted/50 p-4" aria-label={m.catalogue_reports_current_subject()}>
                  <h3 className="font-semibold">{m.catalogue_reports_current_subject()}</h3>
                  {page.subject.state === 'loading' || page.subject.state === 'idle' ? (
                    <p role="status" className="mt-2 text-sm text-muted-foreground">
                      {m.moderation_queue_loading()}
                    </p>
                  ) : page.subject.state === 'loaded' ? (
                    <div className="mt-2 break-words text-sm">
                      <p className="font-medium">{page.subject.subject.label}</p>
                      {page.subject.subject.description ? (
                        <p className="mt-1 whitespace-pre-wrap">{page.subject.subject.description}</p>
                      ) : null}
                      <p className="text-muted-foreground">{page.subject.subject.type}</p>
                      <p className="break-all text-muted-foreground">{page.subject.subject.id}</p>
                    </div>
                  ) : page.subject.state === 'error' ? (
                    <div className="mt-2">
                      <p role="alert" className="text-sm text-muted-foreground">
                        {m.moderation_appeals_read_unavailable()}
                      </p>
                      <Button className="mt-2" size="sm" variant="outline" onClick={onRetrySubject}>
                        {m.moderation_queue_retry()}
                      </Button>
                    </div>
                  ) : page.subject.state === 'changed' ? (
                    <p role="status" className="mt-2 text-sm">
                      {m.catalogue_reports_visibility_confirmed({
                        visibility: reportVisibilityLabel(page.subject.visibility),
                      })}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">{m.moderation_target_unavailable()}</p>
                  )}
                </section>
                {!page.command && page.action.state === 'uncertain' ? (
                  <div className="mt-5">
                    <p role="alert" className="text-sm text-destructive">
                      {m.moderation_queue_uncertain()}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">{m.moderation_queue_retry_hint()}</p>
                    <Button className="mt-3" onClick={onRetryAction}>
                      {m.moderation_queue_retry_action()}
                    </Button>
                  </div>
                ) : null}
                {!page.command && failedText ? (
                  <div className="mt-5">
                    <p role="alert" className="text-sm text-destructive">
                      {failedText}
                    </p>
                    <Button className="mt-3" variant="outline" onClick={onRefresh}>
                      {m.moderation_queue_refresh()}
                    </Button>
                  </div>
                ) : null}
                {page.action.state === 'invalid' ? (
                  <p role="alert" className="mt-4 text-sm text-destructive">
                    {m.moderation_queue_reason_invalid()}
                  </p>
                ) : null}
                {!page.command && page.action.state === 'confirmed' && page.action.result.kind === 'dismissed' ? (
                  <p role="status" className="mt-5 text-sm font-medium">
                    {m.moderation_dismissed()}
                  </p>
                ) : null}
                {!page.command && page.action.state === 'confirmed' && page.action.result.kind === 'visibility' ? (
                  <p role="status" className="mt-5 text-sm font-medium">
                    {m.catalogue_reports_visibility_confirmed({
                      visibility: reportVisibilityLabel(page.action.result.visibility),
                    })}
                  </p>
                ) : null}
                {!page.command && (page.action.state === 'confirmed' || page.action.state === 'failed') ? (
                  <Button className="mt-4" variant="outline" onClick={onRefresh}>
                    {m.moderation_queue_refresh()}
                  </Button>
                ) : null}
                {selected.outcome === null && page.subject.state === 'loaded' ? (
                  <fieldset className="mt-6 grid gap-3 border-t pt-5" disabled={locked}>
                    <label className="grid gap-2 text-sm font-medium">
                      {m.moderation_reason_label()}
                      <Textarea
                        value={page.reason}
                        maxLength={1024}
                        onChange={(event) => onReason(event.currentTarget.value)}
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={() => onAct('dismiss')}>
                        {m.moderation_dismiss()}
                      </Button>
                      <Button onClick={() => onAct('hide')}>{m.catalogue_reports_hide_subject()}</Button>
                    </div>
                  </fieldset>
                ) : null}
                {canRestore && selected.outcome !== 'dismissed' ? (
                  <fieldset className="mt-6 grid gap-3 border-t pt-5" disabled={locked}>
                    <label className="grid gap-2 text-sm font-medium">
                      {m.moderation_reason_label()}
                      <Textarea
                        value={page.reason}
                        maxLength={1024}
                        onChange={(event) => onReason(event.currentTarget.value)}
                      />
                    </label>
                    <Button variant="outline" onClick={() => onAct('restore')}>
                      {m.catalogue_reports_restore_subject()}
                    </Button>
                  </fieldset>
                ) : null}
              </article>
              {page.command ? (
                <section
                  className="min-w-0 rounded-2xl border p-4 sm:p-6"
                  aria-label={actionLabel(page.command.input.action)}
                >
                  <h2 className="text-lg font-semibold">{actionLabel(page.command.input.action)}</h2>
                  <dl className="mt-4 grid gap-3 text-sm">
                    <div>
                      <dt className="font-medium">{m.moderation_queue_submission()}</dt>
                      <dd className="mt-1 break-all">{page.command.report.id}</dd>
                    </div>
                    <div>
                      <dt className="font-medium">{m.catalogue_reports_current_subject()}</dt>
                      <dd className="mt-1 break-all">{page.command.input.subjectId}</dd>
                    </div>
                    {'reason' in page.command.input ? (
                      <div>
                        <dt className="font-medium">{m.moderation_reason_label()}</dt>
                        <dd className="mt-1 whitespace-pre-wrap break-words">{page.command.input.reason}</dd>
                      </div>
                    ) : null}
                  </dl>
                  {page.action.state === 'sending' ? (
                    <p role="status" className="mt-5 text-sm text-muted-foreground">
                      {m.moderation_queue_loading()}
                    </p>
                  ) : null}
                  {page.action.state === 'uncertain' ? (
                    <div className="mt-5">
                      <p role="alert" className="text-sm text-destructive">
                        {m.moderation_queue_uncertain()}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">{m.moderation_queue_retry_hint()}</p>
                      <Button className="mt-3" onClick={onRetryAction}>
                        {m.moderation_queue_retry_action()}
                      </Button>
                    </div>
                  ) : null}
                  {failedText ? (
                    <div className="mt-5">
                      <p role="alert" className="text-sm text-destructive">
                        {failedText}
                      </p>
                    </div>
                  ) : null}
                  {page.action.state === 'confirmed' && page.action.result.kind === 'dismissed' ? (
                    <p role="status" className="mt-5 text-sm font-medium">
                      {m.moderation_dismissed()}
                    </p>
                  ) : null}
                  {page.action.state === 'confirmed' && page.action.result.kind === 'visibility' ? (
                    <p role="status" className="mt-5 text-sm font-medium">
                      {m.catalogue_reports_visibility_confirmed({
                        visibility: reportVisibilityLabel(page.action.result.visibility),
                      })}
                    </p>
                  ) : null}
                  {page.action.state === 'confirmed' || page.action.state === 'failed' ? (
                    <Button className="mt-4" variant="outline" onClick={onRefresh}>
                      {m.moderation_queue_refresh()}
                    </Button>
                  ) : null}
                  <details className="mt-5 rounded-xl border px-4 py-3">
                    <summary className="cursor-pointer font-medium">{m.moderation_queue_submission()}</summary>
                    <dl className="mt-4 grid gap-3 text-sm">
                      <div>
                        <dt className="font-medium">{m.moderation_reason_label()}</dt>
                        <dd className="mt-1 whitespace-pre-wrap break-words">{page.command.report.reason}</dd>
                      </div>
                      {page.command.report.revisionId ? (
                        <div>
                          <dt className="font-medium">{m.moderation_reported_revision_label()}</dt>
                          <dd className="mt-1 break-all">{page.command.report.revisionId}</dd>
                        </div>
                      ) : null}
                      {page.command.report.evidence ? (
                        <div>
                          <dt className="font-medium">{m.moderation_queue_submission()}</dt>
                          <dd className="mt-1 whitespace-pre-wrap break-words">{page.command.report.evidence}</dd>
                        </div>
                      ) : null}
                    </dl>
                  </details>
                </section>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      {page.reports.length === 0 && page.next ? (
        <Button className="mt-5" variant="outline" onClick={() => onNext(page.next!)}>
          {m.threads_next_page()}
        </Button>
      ) : null}
      {page.reports.length > 0 && page.next ? (
        <p className="sr-only" aria-live="polite">
          {m.moderation_queue_next_hint()}
        </p>
      ) : null}
    </main>
  );
}

export function CatalogueReportsCurrent({
  initial,
  readPage,
  readSubject,
  action,
  onNext,
  onRestart,
}: {
  initial: CatalogueReportsRead;
  readPage: CatalogueReportsReader;
  readSubject: CatalogueSubjectReader;
  action: CatalogueReportCommand;
  onNext: (cursor: string) => void;
  onRestart: () => void;
}) {
  const cache = useQueryClient();
  const [original] = useState({ cache, initial, readPage, readSubject, action });
  const journey = useMemo(() => createCatalogueReportsJourney(original), [original]);
  const [page, setPage] = useState(() => journey.snapshot());
  useEffect(() => {
    const unsubscribe = journey.subscribe(() => setPage(journey.snapshot()));
    setPage(journey.snapshot());
    const current = journey.snapshot();
    if (current.state === 'loaded' && current.selectedId) void journey.select(current.selectedId);
    return () => {
      unsubscribe();
      journey.retire();
    };
  }, [journey]);
  if (cache !== original.cache || initial !== original.initial) journey.retire();
  return (
    <CatalogueReportsView
      page={page}
      onSelect={(id) => void journey.select(id)}
      onReason={journey.changeReason}
      onAct={journey.act}
      onRetryAction={journey.retryAction}
      onRetryPage={journey.retryPage}
      onRetrySubject={journey.retrySubject}
      onRefresh={journey.refresh}
      onNext={onNext}
      onRestart={onRestart}
    />
  );
}

const nativeAction: CatalogueReportCommand = async (input) => actOnCatalogueReport({ data: input });

export function CatalogueReportsVisit({
  cursor,
  onNext,
  onRestart,
}: {
  cursor?: string;
  onNext: (cursor: string) => void;
  onRestart: () => void;
}) {
  const cache = useQueryClient();
  const [visit, setVisit] = useState<{ initial: CatalogueReportsRead; readPage: CatalogueReportsReader } | null>(null);
  const [readError, setReadError] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setVisit(null);
    setReadError(false);
    const pageReader: CatalogueReportsReader = (input) =>
      prepareCatalogueReportsRead(
        cache,
        input.cursor,
        async (data) => loadCatalogueReports({ data }),
        controller.signal,
      );
    void pageReader(cursor ? { cursor } : {})
      .then((initial) => {
        if (current) setVisit({ initial, readPage: pageReader });
      })
      .catch(() => {
        if (current) setReadError(true);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [cache, cursor, readAttempt]);
  if (readError)
    return (
      <CatalogueReportsView
        page={{ state: 'error', reports: [], next: null }}
        onSelect={() => {}}
        onReason={() => {}}
        onAct={() => {}}
        onRetryAction={() => {}}
        onRetryPage={() => setReadAttempt((attempt) => attempt + 1)}
        onRetrySubject={() => {}}
        onRefresh={() => {}}
        onNext={onNext}
        onRestart={onRestart}
      />
    );
  if (!visit)
    return (
      <CatalogueReportsView
        page={loading}
        onSelect={() => {}}
        onReason={() => {}}
        onAct={() => {}}
        onRetryAction={() => {}}
        onRetryPage={() => {}}
        onRetrySubject={() => {}}
        onRefresh={() => {}}
        onNext={onNext}
        onRestart={onRestart}
      />
    );
  const readSubject: CatalogueSubjectReader = (subjectId, reportId) =>
    loadCatalogueSubject({ data: { subjectId, reportId } });
  return (
    <CatalogueReportsCurrent
      key={visit.initial.readerBinding?.id ?? catalogueReportsReadKey(cursor)}
      initial={visit.initial}
      readPage={visit.readPage}
      readSubject={readSubject}
      action={nativeAction}
      onNext={onNext}
      onRestart={onRestart}
    />
  );
}

export { CATALOGUE_REPORTS_LIMIT };
