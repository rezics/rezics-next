import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentActions } from '@rezics/ui/content-actions';
import { Input } from '@rezics/ui/shadcn/input';
import type { ReportDialogLabels, ReportSubmission } from '@rezics/ui/report-dialog';
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
} from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { sessionQuery } from '../session/query';
import { sendReport } from './actions';
import type { ReportResult } from './submit.server';
import { Verification, type VerificationConfig } from './turnstile';

type SessionRecord = {
  state?: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable' | string;
  subject?: string | null;
  csrfToken?: string | null;
};

type SessionAuthority = {
  available: boolean;
  session: SessionRecord | undefined;
  fingerprint: string;
};

type SessionObservation = {
  id: number;
  subscribe: (notify: () => void) => () => void;
  snapshot: () => number;
  read: () => SessionAuthority;
};

let observationId = 0;
const useClientLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

function sessionFingerprint(session: SessionRecord | undefined, available: boolean): string {
  return JSON.stringify([available, session?.state ?? 'unknown', session?.subject ?? null, session?.csrfToken ?? null]);
}

/** Watch only the session already in QueryClient. A cache success is an ownership event, even when its data echoes. */
function observeSession(client: QueryClient | undefined): SessionObservation {
  let revision = 0;
  return {
    id: ++observationId,
    subscribe(notify) {
      if (!client) return () => {};
      return client.getQueryCache().subscribe((event) => {
        const query = 'query' in event ? event.query : undefined;
        if (!query || query.queryKey.length !== 1 || query.queryKey[0] !== sessionQuery.queryKey[0]) return;
        const ownershipEvent =
          event.type === 'added' ||
          event.type === 'removed' ||
          (event.type === 'updated' &&
            (event.action.type === 'success' || event.action.type === 'setState' || event.action.type === 'error'));
        if (!ownershipEvent) return;
        revision += 1;
        notify();
      });
    },
    snapshot: () => revision,
    read() {
      const state = client?.getQueryState(sessionQuery.queryKey);
      const session = client?.getQueryData<SessionRecord>(sessionQuery.queryKey);
      const available = state?.status === 'success' && session !== undefined;
      return { available, session, fingerprint: sessionFingerprint(session, available) };
    },
  };
}

function reportCredential(authority: SessionAuthority): { csrfToken: string } | null {
  if (!authority.available || !authority.session) return null;
  if (authority.session.state === 'signed-out') return { csrfToken: '' };
  if (
    authority.session.state === 'signed-in' &&
    typeof authority.session.subject === 'string' &&
    authority.session.subject.length > 0 &&
    typeof authority.session.csrfToken === 'string' &&
    authority.session.csrfToken.length > 0
  )
    return { csrfToken: authority.session.csrfToken };
  return null;
}

function labels(): ReportDialogLabels {
  return {
    title: m.report_title(),
    description: m.report_description(),
    reasons: m.report_reasons(),
    offTopic: m.report_off_topic(),
    offTopicDescription: m.report_off_topic_description(),
    inappropriate: m.report_inappropriate(),
    inappropriateDescription: m.report_inappropriate_description(),
    spam: m.report_spam(),
    spamDescription: m.report_spam_description(),
    illegal: m.report_illegal(),
    illegalDescription: m.report_illegal_description(),
    other: m.report_other(),
    otherDescription: m.report_other_description(),
    details: m.report_details(),
    detailsRequiredHint: m.report_details_hint(),
    characterCount: m.report_count(),
    characterCountText: m.report_count_text({ count: '{count}', max: '{max}' }),
    verification: m.report_verification(),
    submit: m.report_submit(),
    submitting: m.report_submitting(),
    cancel: m.report_cancel(),
    success: m.report_success(),
    successDescription: m.report_success_description(),
    failure: m.report_unavailable(),
  };
}

function refusalText(result: Extract<ReportResult, { ok: false }>): string {
  switch (result.reason) {
    case 'closed':
      return m.platform_closed_message();
    case 'forbidden':
      return m.report_forbidden();
    case 'invalid':
      return m.report_invalid();
    case 'rate-limited':
      return m.report_rate_limited({ seconds: result.retryAfter ?? 1 });
    default:
      return m.report_unavailable();
  }
}

type OwnerToken = { key: string; value: object };
type CopyFocusIntent = {
  active: boolean;
  claimed: boolean;
  allowTriggerRestore: boolean;
  dispose: () => void;
};
type CopyResult =
  | { kind: 'copied' }
  | { kind: 'manual'; url: string; isCurrent: () => boolean; focusIntent: CopyFocusIntent | null };

/** The overflow menu of a thread, post or subject the viewer did not write: copy its link or report it. */
export function PostActions({
  target,
  revisionId,
  verification,
}: {
  target: { kind: 'thread' | 'post' | 'subject'; id: string };
  revisionId?: string;
  verification: VerificationConfig;
}) {
  const client = useContext(QueryClientContext);
  const observation = useMemo(() => observeSession(client), [client]);
  const sessionRevision = useSyncExternalStore(observation.subscribe, observation.snapshot, () => 0);
  const authority = observation.read();
  const ownerKey = JSON.stringify([
    observation.id,
    sessionRevision,
    authority.fingerprint,
    target.kind,
    target.id,
    revisionId ?? null,
  ]);
  const ownerRef = useRef<OwnerToken | null>(null);
  if (!ownerRef.current || ownerRef.current.key !== ownerKey) ownerRef.current = { key: ownerKey, value: {} };
  const owner = ownerRef.current;

  return (
    <ReportActionsVisit
      key={ownerKey}
      activeOwner={ownerRef}
      owner={owner.value}
      observation={observation}
      sessionRevision={sessionRevision}
      sessionFingerprint={authority.fingerprint}
      target={target}
      {...(revisionId !== undefined ? { revisionId } : {})}
      verification={verification}
    />
  );
}

function ReportActionsVisit({
  activeOwner,
  owner,
  observation,
  sessionRevision,
  sessionFingerprint: admittedFingerprint,
  target,
  revisionId,
  verification,
}: {
  activeOwner: MutableRefObject<OwnerToken | null>;
  owner: object;
  observation: SessionObservation;
  sessionRevision: number;
  sessionFingerprint: string;
  target: { kind: 'thread' | 'post' | 'subject'; id: string };
  revisionId?: string;
  verification: VerificationConfig;
}) {
  const [reportOpen, setReportOpen] = useState(false);
  // A new open also retires retained shared form handlers from the previous ceremony.
  const [ceremony, setCeremony] = useState(0);
  const ceremonyRef = useRef(0);
  const reportOpenRef = useRef(false);
  const openIncarnation = useRef(0);
  // Equal token bytes from a later vendor callback do not re-admit an older submit closure.
  const [token, setToken] = useState({ value: '', revision: 0 });
  const tokenRef = useRef('');
  const tokenRevision = useRef(0);
  const idempotencyKey = useRef('');
  const [reportId, setReportId] = useState<string | null>(null);
  const reset = useRef<(() => void) | null>(null);
  const mounted = useRef(false);
  const copyTrigger = useRef<HTMLButtonElement>(null);
  const copyField = useRef<HTMLInputElement>(null);
  const copyAttempt = useRef(0);
  const keyboardCopyActivation = useRef<CopyFocusIntent | null>(null);
  const copyFocusIntent = useRef<CopyFocusIntent | null>(null);
  const copyFieldId = useId();
  const copyStatusId = useId();
  const [copyResult, setCopyResult] = useState<CopyResult | null>(null);
  const ownerTarget = { kind: target.kind, id: target.id };

  const cancelCopyFocusIntent = useCallback((intent: CopyFocusIntent | null = copyFocusIntent.current) => {
    if (!intent) return;
    intent.active = false;
    intent.dispose();
    if (keyboardCopyActivation.current === intent) keyboardCopyActivation.current = null;
    if (copyFocusIntent.current === intent) copyFocusIntent.current = null;
  }, []);

  const armKeyboardCopyIntent = useCallback(() => {
    cancelCopyFocusIntent();
    const doc = copyTrigger.current?.ownerDocument;
    if (!doc) return;

    let intent: CopyFocusIntent;
    const cancel = () => cancelCopyFocusIntent(intent);
    const onFocusIn = (event: FocusEvent) => {
      if (event.target === copyTrigger.current && intent.allowTriggerRestore) {
        intent.allowTriggerRestore = false;
        return;
      }
      cancel();
    };
    intent = {
      active: true,
      claimed: false,
      allowTriggerRestore: true,
      dispose: () => {
        doc.removeEventListener('pointerdown', cancel, true);
        doc.removeEventListener('keydown', cancel, true);
        doc.removeEventListener('focusin', onFocusIn, true);
      },
    };
    keyboardCopyActivation.current = intent;
    copyFocusIntent.current = intent;
    doc.addEventListener('pointerdown', cancel, true);
    doc.addEventListener('keydown', cancel, true);
    doc.addEventListener('focusin', onFocusIn, true);
  }, [cancelCopyFocusIntent]);

  const onCopyMenuKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const menuItem = target.closest('[role="menuitem"]');
    if ((menuItem?.getAttribute('aria-label') ?? menuItem?.textContent?.trim()) === m.report_copy())
      armKeyboardCopyIntent();
  };

  useClientLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reportOpenRef.current = false;
      openIncarnation.current += 1;
      tokenRevision.current += 1;
      tokenRef.current = '';
      idempotencyKey.current = '';
      cancelCopyFocusIntent();
      copyAttempt.current += 1;
    };
  }, [cancelCopyFocusIntent]);

  const currentOwner = useCallback(() => {
    if (!mounted.current || activeOwner.current?.value !== owner) return false;
    if (observation.snapshot() !== sessionRevision) return false;
    return observation.read().fingerprint === admittedFingerprint;
  }, [activeOwner, admittedFingerprint, observation, owner, sessionRevision]);

  const currentOpen = useCallback(
    (incarnation: number) => currentOwner() && reportOpenRef.current && openIncarnation.current === incarnation,
    [currentOwner],
  );

  const currentAuthority = observation.read();
  const canReport = Boolean(reportCredential(currentAuthority)) && currentAuthority.fingerprint === admittedFingerprint;
  const renderIncarnation = openIncarnation.current;

  useEffect(() => {
    if (copyResult?.kind !== 'manual') return;
    const intent = copyResult.focusIntent;
    if (!intent) return;
    const frame = requestAnimationFrame(() => {
      const field = copyField.current;
      if (
        !intent.active ||
        !intent.claimed ||
        copyFocusIntent.current !== intent ||
        !copyResult.isCurrent() ||
        !field?.isConnected
      ) {
        cancelCopyFocusIntent(intent);
        return;
      }
      cancelCopyFocusIntent(intent);
      field.focus();
      field.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [cancelCopyFocusIntent, copyResult]);

  const retireCopyResult = useCallback(() => {
    cancelCopyFocusIntent();
    copyAttempt.current += 1;
    setCopyResult(null);
  }, [cancelCopyFocusIntent]);

  const updateToken = useCallback(
    (next: string) => {
      if (!currentOpen(renderIncarnation)) return;
      tokenRevision.current += 1;
      tokenRef.current = next;
      setToken({ value: next, revision: tokenRevision.current });
    },
    [currentOpen, renderIncarnation],
  );

  const startChallenge = useCallback(() => {
    if (!currentOpen(renderIncarnation)) return;
    if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();
  }, [currentOpen, renderIncarnation]);

  const changeReportOpen = useCallback(
    (next: boolean) => {
      if (!currentOwner() || renderIncarnation !== openIncarnation.current) return;
      if (next) {
        if (reportOpenRef.current) return;
        retireCopyResult();
        reportOpenRef.current = true;
        openIncarnation.current += 1;
        ceremonyRef.current += 1;
        tokenRevision.current += 1;
        tokenRef.current = '';
        idempotencyKey.current = crypto.randomUUID();
        reset.current = null;
        setToken({ value: '', revision: tokenRevision.current });
        setCeremony(openIncarnation.current);
        setReportId(null);
        setReportOpen(true);
        return;
      }

      if (renderIncarnation !== openIncarnation.current || !reportOpenRef.current) return;
      retireCopyResult();
      reportOpenRef.current = false;
      openIncarnation.current += 1;
      tokenRevision.current += 1;
      tokenRef.current = '';
      idempotencyKey.current = '';
      reset.current = null;
      setToken({ value: '', revision: tokenRevision.current });
      setReportOpen(false);
    },
    [currentOwner, renderIncarnation, retireCopyResult],
  );

  const report = useCallback(
    async ({ reason, details }: ReportSubmission) => {
      const incarnation = renderIncarnation;
      const submittedToken = token.value;
      const submittedTokenRevision = token.revision;
      const submittedKey = idempotencyKey.current;
      const submittedReset = reset.current;
      const admittedTarget = { kind: ownerTarget.kind, id: ownerTarget.id };
      const admittedRevision = revisionId;

      const currentVisit = () => currentOpen(incarnation) && idempotencyKey.current === submittedKey;
      const currentAttempt = () =>
        currentVisit() && tokenRef.current === submittedToken && tokenRevision.current === submittedTokenRevision;
      if (!currentAttempt() || !submittedToken || !submittedKey || !canReport) throw new Error(m.report_unavailable());

      const authority = observation.read();
      const credential = reportCredential(authority);
      if (!credential || authority.fingerprint !== admittedFingerprint || observation.snapshot() !== sessionRevision)
        throw new Error(m.report_unavailable());

      let result: ReportResult;
      try {
        result = await sendReport({
          data: {
            target: admittedTarget,
            ...(admittedRevision !== undefined ? { revisionId: admittedRevision } : {}),
            reason,
            ...(details ? { evidence: details } : {}),
            botToken: submittedToken,
            idempotencyKey: submittedKey,
          },
          headers: { 'X-CSRF-Token': credential.csrfToken },
        });
      } catch {
        if (!currentVisit()) return;
        if (currentAttempt()) submittedReset?.();
        throw new Error(m.report_unavailable());
      }

      if (!currentVisit()) return;
      if (!result.ok) {
        if (currentAttempt()) submittedReset?.();
        throw new Error(refusalText(result));
      }
      setReportId(result.reportId);
    },
    [
      admittedFingerprint,
      canReport,
      currentOpen,
      observation,
      ownerTarget.id,
      ownerTarget.kind,
      renderIncarnation,
      revisionId,
      sessionRevision,
      token,
    ],
  );

  const copyLink = async () => {
    const activation = keyboardCopyActivation.current;
    keyboardCopyActivation.current = null;
    const focusIntent =
      activation?.active && !activation.claimed && copyFocusIntent.current === activation ? activation : null;
    if (focusIntent) focusIntent.claimed = true;
    else cancelCopyFocusIntent();

    const url = `${location.origin}${location.pathname}${target.kind === 'subject' ? '' : `#${target.kind}-${target.id}`}`;
    const attempt = ++copyAttempt.current;
    const admittedCeremony = ceremony;
    const admittedRender = renderIncarnation;
    const isCurrent = () =>
      copyAttempt.current === attempt &&
      ceremonyRef.current === admittedCeremony &&
      openIncarnation.current === admittedRender &&
      currentOwner();
    if (!isCurrent()) return;
    setCopyResult(null);
    try {
      await navigator.clipboard.writeText(url);
      if (isCurrent()) setCopyResult({ kind: 'copied' });
      if (focusIntent) cancelCopyFocusIntent(focusIntent);
    } catch {
      if (isCurrent()) setCopyResult({ kind: 'manual', url, isCurrent, focusIntent });
      else if (focusIntent) cancelCopyFocusIntent(focusIntent);
    }
  };

  const closeCopyRecovery = () => {
    const returnFocus = copyResult?.kind === 'manual' && copyResult.isCurrent();
    retireCopyResult();
    if (returnFocus && copyTrigger.current?.isConnected) copyTrigger.current.focus();
  };

  return (
    <>
      <div className="contents" onKeyDownCapture={onCopyMenuKeyDownCapture}>
        <ContentActions
          key={ceremony}
          ownsContent={false}
          onCopyLink={copyLink}
          triggerRef={copyTrigger}
          onReport={report}
          onReportOpenChange={changeReportOpen}
          reportOpen={reportOpen}
          labels={{ moreActions: m.report_more(), copyLink: m.report_copy(), report: m.report_action() }}
          reportLabels={labels()}
          maxDetails={4096}
          verified={canReport && Boolean(token.value)}
          verification={
            <Verification
              config={verification}
              locale={getLocale()}
              onToken={updateToken}
              reset={reset}
              onStart={startChallenge}
            />
          }
        />
      </div>
      {/* Keep the selected URL and its deliberate Close action together in the content action flow. */}
      {copyResult ? (
        <div className="min-w-0 max-w-full space-y-2 text-sm">
          <p id={copyStatusId} role="status">
            {copyResult.kind === 'copied' ? m.report_copy_success() : m.report_copy_recovery_description()}
          </p>
          {copyResult.kind === 'manual' ? (
            <>
              <label htmlFor={copyFieldId} className="block">
                {m.report_copy_recovery_link_label()}
              </label>
              <Input
                ref={copyField}
                id={copyFieldId}
                aria-describedby={copyStatusId}
                type="text"
                dir="ltr"
                readOnly
                spellCheck={false}
                value={copyResult.url}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return;
                  event.preventDefault();
                  closeCopyRecovery();
                }}
              />
              <Button type="button" variant="outline" onClick={closeCopyRecovery}>
                {m.report_copy_recovery_close()}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {reportId && currentAuthority.session?.state === 'signed-in' && currentAuthority.session.subject ? (
        <a className="text-sm underline underline-offset-4" href={localizeHref(`/moderation/reports/${reportId}`)}>
          {m.reporter_status_view()}
        </a>
      ) : null}
    </>
  );
}
