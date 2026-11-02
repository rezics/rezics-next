import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { ArrowLeft, Check, CircleCheck, CircleMinus, Clock3, Copy, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  createReporterStatusJourney,
  type ReporterStatusRead,
  type ReporterStatusNavigation,
  type ReporterStatusReader,
  type ReporterStatusResult,
} from './reporter-status-read-model';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import type { ReporterStatus } from './reporter-status-model';

type RetryActivation = { keyboard: boolean; source: HTMLButtonElement };
type Retry = (activation?: RetryActivation) => void | Promise<void>;

/** The served page and its stories share this composition within the site's AppShell. */
export function ReporterStatusPage(
  props:
    | { report: ReporterStatus; isCurrent?: () => boolean; onRefresh?: Retry }
    | { onRetry: Retry }
    | { state: 'loading' | 'concealed' | 'closed' },
) {
  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8 sm:py-10" aria-labelledby="reporter-status-heading">
      <a
        href={localizeHref('/inbox')}
        className="mb-6 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {m.reporter_status_back()}
      </a>
      {'report' in props ? (
        <ReporterStatusView {...props} />
      ) : 'onRetry' in props ? (
        <ReporterStatusFailure onRetry={props.onRetry} />
      ) : (
        <ReporterStatusReadState state={props.state} />
      )}
    </section>
  );
}

const readCurrent: ReporterStatusReader = async (data) =>
  (await import('./reporter-status-read')).readReporterStatus({ data });

/** Default route composition, with synchronous observation of the real browser session cache. */
export function ReporterStatusCurrent(props: { initial: ReporterStatusRead; navigation?: ReporterStatusNavigation }) {
  return <ReporterStatusVisit key={props.initial.generation} {...props} />;
}

function ReporterStatusVisit({
  initial,
  navigation,
}: {
  initial: ReporterStatusRead;
  navigation?: ReporterStatusNavigation;
}) {
  const cache = useQueryClient();
  const [original] = useState({ cache, initial, navigation });
  const journey = useMemo(
    () => createReporterStatusJourney(original.cache, original.initial, readCurrent, original.navigation),
    [original],
  );
  if (
    cache !== original.cache ||
    navigation !== original.navigation ||
    initial.id !== original.initial.id ||
    initial.generation !== original.initial.generation
  )
    journey.retire();
  const result = useSyncExternalStore(journey.subscribe, journey.snapshot, journey.serverSnapshot);
  return (
    <div
      onClickCapture={(event) => {
        if ((event.target as Element).closest('a') && !journey.isConnected()) event.preventDefault();
      }}
    >
      <ReporterStatusResultPage
        result={result}
        onRetry={() => journey.retry()}
        onRefresh={() => journey.refresh()}
        isCurrent={journey.isCurrent}
        retryFocusScope={journey}
        isRetryFocusScopeCurrent={journey.isConnected}
      />
    </div>
  );
}

export function ReporterStatusResultPage({
  result,
  onRetry,
  onRefresh,
  isCurrent,
  retryFocusScope,
  isRetryFocusScopeCurrent,
}: {
  result: ReporterStatusResult;
  onRetry: Retry;
  onRefresh?: Retry;
  isCurrent?: () => boolean;
  retryFocusScope?: object;
  isRetryFocusScopeCurrent?: () => boolean;
}) {
  const boundary = useRef<HTMLDivElement>(null);
  const retryFocusGeneration = useRef(0);
  const [retryFocus, setRetryFocus] = useState<{
    id: number;
    scope: object;
    source: HTMLButtonElement;
    settled: boolean;
  } | null>(null);
  async function retry(activation?: RetryActivation) {
    const request =
      activation?.keyboard && retryFocusScope && isRetryFocusScopeCurrent?.()
        ? {
            id: ++retryFocusGeneration.current,
            scope: retryFocusScope,
            source: activation.source,
            settled: false,
          }
        : null;
    if (request) setRetryFocus(request);
    try {
      await onRetry();
    } finally {
      if (request) setRetryFocus((current) => (current?.id === request.id ? { ...request, settled: true } : current));
    }
  }
  useEffect(() => {
    if (!retryFocus) return;
    const document = boundary.current?.ownerDocument;
    if (!document) return;
    const retire = () => setRetryFocus((current) => (current?.id === retryFocus.id ? null : current));
    const focusMoved = (event: FocusEvent) => {
      if (event.target === retryFocus.source) return;
      if (event.target === document.body && !retryFocus.source.isConnected) return;
      retire();
    };
    const pointerMoved = () => retire();
    const tabbed = (event: KeyboardEvent) => {
      if (event.key === 'Tab') retire();
    };
    document.addEventListener('focusin', focusMoved, true);
    document.addEventListener('pointerdown', pointerMoved, true);
    document.addEventListener('keydown', tabbed, true);
    return () => {
      document.removeEventListener('focusin', focusMoved, true);
      document.removeEventListener('pointerdown', pointerMoved, true);
      document.removeEventListener('keydown', tabbed, true);
    };
  }, [retryFocus]);
  useEffect(() => {
    if (!retryFocus) return;
    const retire = () => setRetryFocus((current) => (current?.id === retryFocus.id ? null : current));
    if (
      retryFocus.scope !== retryFocusScope ||
      !isRetryFocusScopeCurrent?.() ||
      result.state === 'concealed' ||
      result.state === 'closed'
    ) {
      retire();
      return;
    }
    if (!retryFocus.settled || result.state === 'loading') return;
    if (result.state !== 'loaded' && result.state !== 'unavailable') {
      retire();
      return;
    }
    const root = boundary.current;
    const heading = root?.querySelector<HTMLHeadingElement>('h1#reporter-status-heading');
    const document = root?.ownerDocument;
    if (
      heading &&
      document &&
      (document.activeElement === retryFocus.source ||
        document.activeElement === document.body ||
        !retryFocus.source.isConnected)
    )
      heading.focus();
    retire();
  }, [retryFocus, result, retryFocusScope, isRetryFocusScopeCurrent]);
  const page =
    result.state === 'loaded' ? (
      <ReporterStatusPage
        report={result.report}
        {...(onRefresh ? { onRefresh } : {})}
        {...(isCurrent ? { isCurrent } : {})}
      />
    ) : result.state === 'unavailable' ? (
      <ReporterStatusPage onRetry={retry} />
    ) : (
      <ReporterStatusPage state={result.state} />
    );
  return <div ref={boundary}>{page}</div>;
}

export function ReporterStatusReadState({ state }: { state: 'loading' | 'concealed' | 'closed' }) {
  return (
    <section className="space-y-6" aria-labelledby="reporter-status-heading">
      <h1 id="reporter-status-heading" className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
        {m.reporter_status_heading()}
      </h1>
      <p role="status" className="leading-7 text-muted-foreground">
        {state === 'loading'
          ? m.reporter_status_read_loading()
          : state === 'closed'
            ? m.reporter_status_read_closed()
            : m.reporter_status_read_concealed()}
      </p>
    </section>
  );
}

/** Own-submission presentation has no shadcn equivalent; it composes existing controls.
 * Available is an annotation, never permission or a link to the target. */
export function ReporterStatusView({
  report,
  isCurrent,
  onRefresh,
}: {
  report: ReporterStatus;
  isCurrent?: () => boolean;
  onRefresh?: Retry;
}) {
  const reason = {
    off_topic: m.report_off_topic,
    inappropriate: m.report_inappropriate,
    spam: m.report_spam,
    illegal: m.report_illegal,
    other: m.report_other,
  }[report.reason]();
  const status =
    report.outcome === 'actioned'
      ? { label: m.moderation_actioned(), explanation: m.reporter_status_actioned_explanation(), icon: CircleCheck }
      : report.outcome === 'dismissed'
        ? { label: m.moderation_dismissed(), explanation: m.reporter_status_dismissed_explanation(), icon: CircleMinus }
        : { label: m.reporter_status_pending(), explanation: m.reporter_status_pending_explanation(), icon: Clock3 };
  const StatusIcon = status.icon;
  const targetKind = {
    board: m.reporter_status_board,
    thread: m.reporter_status_thread,
    post: m.reporter_status_post,
  }[report.target.kind]();
  return (
    <article className="space-y-8 break-words" aria-labelledby="reporter-status-heading">
      <header className="space-y-4">
        <h1
          id="reporter-status-heading"
          tabIndex={-1}
          className="font-display text-3xl font-semibold tracking-tight sm:text-4xl"
        >
          {m.reporter_status_heading()}
        </h1>
        <Badge
          variant={report.outcome === 'actioned' ? 'default' : 'secondary'}
          className="h-auto gap-1.5 px-3 py-1.5 text-sm"
        >
          <StatusIcon aria-hidden="true" />
          {status.label}
        </Badge>
        <p className="max-w-prose text-base leading-7 text-muted-foreground">{status.explanation}</p>
        {onRefresh ? (
          <Button variant="outline" className="min-h-11" onClick={() => void onRefresh()}>
            <RefreshCw className="size-4" aria-hidden="true" />
            {m.reporter_status_refresh()}
          </Button>
        ) : null}
      </header>
      <section aria-labelledby="reporter-status-timeline" className="space-y-4">
        <ContentItemHeading id="reporter-status-timeline" level={2} className="text-xl font-semibold">
          {m.reporter_status_timeline()}
        </ContentItemHeading>
        <ContentItemFrame as="div" className="p-5 sm:p-6">
          <ol aria-label={m.reporter_status_timeline()} className="grid gap-5 sm:grid-cols-2">
            <li className="flex gap-3">
              <Check className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
              <div className="space-y-1">
                <p className="font-medium">{m.reporter_status_submitted()}</p>
                <p className="text-sm leading-6 text-muted-foreground">
                  <ReportTime instant={report.createdAt} />
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <StatusIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="space-y-1">
                <p className="font-medium">{m.reporter_status_reviewed()}</p>
                <p className="text-sm leading-6 text-muted-foreground">
                  {report.resolvedAt ? (
                    <ReportTime instant={report.resolvedAt} />
                  ) : report.outcome === null ? (
                    m.reporter_status_awaiting_review()
                  ) : (
                    m.reporter_status_review_time_unavailable()
                  )}
                </p>
              </div>
            </li>
          </ol>
        </ContentItemFrame>
      </section>
      <section aria-labelledby="reporter-status-submission" className="space-y-6">
        <ContentItemFrame as="div" className="space-y-6 p-5 sm:p-6">
          <ContentItemHeading id="reporter-status-submission" level={2} className="text-xl font-semibold">
            {m.reporter_status_submission()}
          </ContentItemHeading>
          <div className="space-y-2">
            <ContentItemHeading level={3} className="text-sm font-medium text-muted-foreground">
              {m.moderation_reason_label()}
            </ContentItemHeading>
            <p className="font-medium">{reason}</p>
          </div>
          <div className="space-y-2">
            <ContentItemHeading level={3} className="text-sm font-medium text-muted-foreground">
              {m.reporter_status_evidence()}
            </ContentItemHeading>
            <p className="whitespace-pre-wrap leading-7">{report.evidence || m.reporter_status_no_evidence()}</p>
          </div>
        </ContentItemFrame>
      </section>
      <section className="space-y-3" aria-labelledby="reporter-status-target">
        <ContentItemFrame as="div" className="space-y-3 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ContentItemHeading id="reporter-status-target" level={2} className="text-lg font-semibold">
              {m.reporter_status_target()}
            </ContentItemHeading>
            <Badge variant="outline">{targetKind}</Badge>
          </div>
          <p className="font-medium">
            {report.targetAvailability === 'unavailable'
              ? m.moderation_target_unavailable()
              : m.reporter_status_available()}
          </p>
          <p className="text-sm leading-6 text-muted-foreground">
            {report.targetAvailability === 'unavailable'
              ? m.reporter_status_retained_submission()
              : m.reporter_status_saved_reference()}
          </p>
        </ContentItemFrame>
      </section>
      <ReportReference key={report.id} report={report} {...(isCurrent ? { isCurrent } : {})} />
    </article>
  );
}

const alwaysCurrent = () => true;

function ReportReference({ report, isCurrent = alwaysCurrent }: { report: ReporterStatus; isCurrent?: () => boolean }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const lifetime = useRef(0);
  const copyGeneration = useRef(0);
  const manualReferenceRef = useRef<HTMLTextAreaElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const manualFocus = useRef<{
    source: HTMLButtonElement;
    details: HTMLDetailsElement;
    report: ReporterStatus;
    isCurrent: () => boolean;
    referenceText: string;
    lifetime: number;
    generation: number;
  } | null>(null);
  const manualFocusCleanup = useRef<(() => void) | null>(null);
  function cancelManualFocus(generation?: number) {
    if (generation !== undefined && manualFocus.current?.generation !== generation) return;
    manualFocus.current = null;
    manualFocusCleanup.current?.();
    manualFocusCleanup.current = null;
  }
  useEffect(() => {
    lifetime.current++;
    return () => {
      lifetime.current++;
    };
  }, [report]);
  useEffect(() => () => cancelManualFocus(), [report, isCurrent]);
  const reference = [
    { label: m.reporter_status_report_id(), value: report.id },
    { label: m.reporter_status_target(), value: `${report.target.kind} ${report.target.id}` },
    ...(report.revisionId ? [{ label: m.reporter_status_revision(), value: report.revisionId }] : []),
  ];
  const referenceText = reference.map(({ label, value }) => `${label}: ${value}`).join('\n');
  useEffect(() => {
    const activation = manualFocus.current;
    if (copyState !== 'failed' || !activation) return;
    const textarea = manualReferenceRef.current;
    if (
      activation.report !== report ||
      activation.isCurrent !== isCurrent ||
      activation.referenceText !== referenceText ||
      activation.lifetime !== lifetime.current ||
      activation.generation !== copyGeneration.current ||
      !isCurrent() ||
      !activation.details.isConnected ||
      !activation.details.open ||
      !activation.source.isConnected ||
      activation.source.ownerDocument.activeElement !== activation.source ||
      !textarea
    ) {
      cancelManualFocus();
      return;
    }
    cancelManualFocus();
    textarea.focus();
    textarea.select();
  }, [copyState, isCurrent, referenceText, report]);
  async function copy(keyboard: boolean, source: HTMLButtonElement) {
    cancelManualFocus();
    if (!isCurrent()) return;
    const mounted = lifetime.current;
    const attempt = ++copyGeneration.current;
    const details = source.closest('details');
    if (keyboard && details) {
      manualFocus.current = { source, details, report, isCurrent, referenceText, lifetime: mounted, generation: attempt };
      const document = source.ownerDocument;
      const retire = () => cancelManualFocus();
      const focusMoved = (event: FocusEvent) => {
        if (event.target !== source) retire();
      };
      const tabbed = (event: KeyboardEvent) => {
        if (event.key === 'Tab') retire();
      };
      const collapsed = () => {
        if (!details.open) retire();
      };
      document.addEventListener('focusin', focusMoved, true);
      document.addEventListener('pointerdown', retire, true);
      document.addEventListener('keydown', tabbed, true);
      details.addEventListener('toggle', collapsed);
      manualFocusCleanup.current = () => {
        document.removeEventListener('focusin', focusMoved, true);
        document.removeEventListener('pointerdown', retire, true);
        document.removeEventListener('keydown', tabbed, true);
        details.removeEventListener('toggle', collapsed);
      };
    }
    const current = () => mounted === lifetime.current && attempt === copyGeneration.current && isCurrent();
    setCopyState('idle');
    try {
      await navigator.clipboard.writeText(referenceText);
      const accepted = current();
      cancelManualFocus(attempt);
      if (accepted) setCopyState('copied');
    } catch {
      if (current()) setCopyState('failed');
      else cancelManualFocus(attempt);
    }
  }
  return (
    <details className="pt-3">
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{m.reporter_status_reference()}</summary>
      <ContentItemFrame as="div" className="space-y-4 p-4">
        <dl className="space-y-4 text-sm">
          {reference.map(({ label, value }) => (
            <div key={label} className="space-y-1">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="select-text break-all font-mono leading-6">{value}</dd>
            </div>
          ))}
        </dl>
        <Button
          ref={copyButtonRef}
          variant="outline"
          className="min-h-11"
          onClick={(event) =>
            void copy(
              event.detail === 0 && event.currentTarget.ownerDocument.activeElement === event.currentTarget,
              event.currentTarget,
            )
          }
        >
          <Copy className="size-4" aria-hidden="true" />
          {m.reporter_status_copy()}
        </Button>
        {copyState === 'failed' && isCurrent() ? (
          <div className="space-y-3">
            <label className="block space-y-2 text-sm font-medium">
              <span>{m.reporter_status_reference()}</span>
              <textarea
                ref={manualReferenceRef}
                className="min-h-24 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm leading-6 select-text"
                readOnly
                rows={reference.length}
                value={referenceText}
              />
            </label>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => {
                cancelManualFocus();
                setCopyState('idle');
                copyButtonRef.current?.focus();
              }}
            >
              {m.board_feed_copy_close()}
            </Button>
          </div>
        ) : null}
        <p role="status" className="text-sm text-muted-foreground">
          {copyState === 'copied'
            ? m.reporter_status_copied()
            : copyState === 'failed'
              ? m.reporter_status_copy_failed()
              : null}
        </p>
      </ContentItemFrame>
    </details>
  );
}

function ReportTime({ instant }: { instant: string }) {
  return (
    <time dateTime={instant}>
      {new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(
        new Date(instant),
      )}{' '}
      UTC
    </time>
  );
}

export function ReporterStatusFailure({ onRetry }: { onRetry: Retry }) {
  const [retrying, setRetrying] = useState(false);
  async function retry(activation: RetryActivation) {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry(activation);
    } catch {
      // A failed read keeps this failure visible and permits another explicit retry.
    } finally {
      setRetrying(false);
    }
  }
  return (
    <section className="space-y-6" aria-labelledby="reporter-status-heading">
      <h1
        id="reporter-status-heading"
        tabIndex={-1}
        className="font-display text-3xl font-semibold tracking-tight sm:text-4xl"
      >
        {m.reporter_status_heading()}
      </h1>
      <p role="alert" className="leading-7 text-muted-foreground">
        {m.reporter_status_unavailable()}
      </p>
      <Button
        className="min-h-11"
        disabled={retrying}
        onClick={(event) =>
          void retry({
            keyboard: event.detail === 0 && event.currentTarget.ownerDocument.activeElement === event.currentTarget,
            source: event.currentTarget,
          })
        }
      >
        {retrying ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
        {retrying ? m.reporter_status_retrying() : m.sources_retry()}
      </Button>
    </section>
  );
}
