import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import {
  ContentSection,
  ContentSectionBody,
  ContentSectionDescription,
  ContentSectionHeader,
  ContentSectionTitle,
} from '@rezics/ui/content-section';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import {
  productionSettingsShellPort,
  useSettingsOperation,
  useSettingsSession,
  useSettingsShell,
} from './adapters/shell';
import {
  unwrapVerificationRead,
  type AgentVerificationRequest,
  type VerificationFailure,
  type VerificationInput,
  type VerificationRecoveryIO,
  type VerificationRecoveryState,
  type VerificationSnapshot,
} from './contract/verification';
import { usePreferenceRetry } from './preference-failure-retry';
import { useSettingsNavigationDraft } from './reading-navigation';
import { verificationNeedsNavigationDecision } from './settings-draft-state';
import { VerificationSubjectChooser, useVerification } from './adapters/verification-view.tsx';
import { VerificationLinks, verificationIssueMessage, type VerificationLinkRow } from './verification-links';
import { validateVerificationDraft, verificationCharacterCount, type VerificationIssue } from './core/verification';
import {
  canRequestVerification,
  canRetryVerification,
  canWithdrawVerification,
  verificationQueryKey,
  verificationWithdrawalObservation,
  type VerificationRecovery,
} from './application/verification';
import {
  readVerificationState,
  readVerificationSubjectTitle,
  requestVerificationAction,
  withdrawVerificationAction,
} from './verification-actions';
import { useSettingsAmbient } from './adapters/ambient-view.tsx';
import type { SettingsAmbient } from './ports/ambient';
import { withVerificationDeadline } from './verification-request-deadline';

import {
  SettingsSessionOwner,
  useSettingsSessionOwner,
  useSettingsReadCurrent,
  useSettingsLiveness,
  useSettingsDisposal,
} from './settings-session-owner';

const verificationActionClassName =
  'h-auto w-full max-w-full whitespace-normal [overflow-wrap:anywhere] sm:w-auto min-h-7';
const verificationSummaryClassName =
  'max-w-full cursor-pointer py-1 whitespace-normal [overflow-wrap:anywhere]';

type VerificationPresentationFocusIntent = {
  id: number;
  kind: 'confirmation-open' | 'confirmation-cancel' | 'result';
  accountId: string;
  observation: string | null;
  snapshot: VerificationRecoveryState;
  ready: boolean;
};

function visibleFocusTarget(target: HTMLElement | null) {
  if (!target?.isConnected || !target.getClientRects().length) return false;
  for (let current: HTMLElement | null = target; current; current = current.parentElement) {
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (
      current.hasAttribute('hidden') ||
      current.hasAttribute('inert') ||
      current.getAttribute('aria-hidden') === 'true' ||
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      style?.visibility === 'collapse' ||
      Number(style?.opacity ?? 1) === 0
    )
      return false;
  }
  return true;
}

type VerificationPresentationFocusIntent = {
  id: number;
  kind: 'confirmation-open' | 'confirmation-cancel' | 'result';
  accountId: string;
  observation: string | null;
  snapshot: VerificationRecoveryState;
  ready: boolean;
};

function visibleFocusTarget(target: HTMLElement | null) {
  if (!target?.isConnected || !target.getClientRects().length) return false;
  for (let current: HTMLElement | null = target; current; current = current.parentElement) {
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (
      current.hasAttribute('hidden') ||
      current.hasAttribute('inert') ||
      current.getAttribute('aria-hidden') === 'true' ||
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      style?.visibility === 'collapse' ||
      Number(style?.opacity ?? 1) === 0
    )
      return false;
  }
  return true;
}

function subjectLabel(title: string | null | undefined, subjectId: string | undefined) {
  return title?.trim() && title !== subjectId ? title : m.settings_verification_generic_subject();
}

function boundedDiagnosticId(value: string | null | undefined) {
  return value && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value) ? value : null;
}

function diagnosticCode(value: string | undefined) {
  return value && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : undefined;
}

function diagnosticRetryAfter(value: string | undefined) {
  if (!value) return undefined;
  // DOM attributes are disclosed too. Keep only the two standard header forms.
  return /^\d{1,10}$/.test(value) ||
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value,
    )
    ? value
    : undefined;
}

function CommandDetails({ failure }: { failure: VerificationFailure }) {
  // Only bounded diagnostic identifiers belong here; never render the transported message or command key.
  const code = diagnosticCode(failure.code);
  const requestId = boundedDiagnosticId(failure.requestId);
  return (
    <details>
      <summary className={verificationSummaryClassName}>{m.settings_verification_command_details()}</summary>
      <div className="space-y-2 break-words">
        <p>{m.settings_verification_read_error({ status: failure.status })}</p>
        {code ? <p>{m.settings_verification_diagnostic_code({ code })}</p> : null}
        {requestId ? <p>{m.settings_verification_diagnostic_request({ requestId })}</p> : null}
      </div>
    </details>
  );
}

function VerificationState({
  verification,
  subjectTitle: suppliedTitle,
}: {
  verification: AgentVerificationRequest | null;
  subjectTitle: string | null;
}) {
  const { subjectHref } = useSettingsShell();
  const accountId = verification?.accountId;
  const subjectId = verification?.catalogueSubjectId;
  const locale = getLocale();
  const titleKey = JSON.stringify([accountId, subjectId, locale]);
  const [hydrated, setHydrated] = useState<{ key: string; title: string | null } | null>(null);
  const ambient = useSettingsAmbient();
  useEffect(() => {
    if (!accountId || !subjectId || suppliedTitle) return;
    const request = new AbortController();
    void withVerificationDeadline(
      (signal) =>
        readVerificationSubjectTitle({
          data: { accountId, subjectId },
          signal,
        }),
      request.signal,
      ambient.timer,
    )
      .then((title) => {
        if (!request.signal.aborted) setHydrated({ key: titleKey, title });
      })
      .catch(() => {});
    return () => request.abort();
  }, [accountId, ambient.timer, subjectId, locale, suppliedTitle, titleKey]);
  const subjectTitle = suppliedTitle ?? (hydrated?.key === titleKey ? hydrated.title : null);
  if (!verification) return null;
  if (verification.state === 'pending')
    return (
      <p>{m.settings_verification_pending({ subject: subjectLabel(subjectTitle, verification.catalogueSubjectId) })}</p>
    );
  if (verification.state === 'approving')
    return (
      <p>
        {m.settings_verification_approving({ subject: subjectLabel(subjectTitle, verification.catalogueSubjectId) })}
      </p>
    );
  if (verification.state === 'approved')
    return (
      <p>
        {m.settings_verification_verified()}{' '}
        <a
          className="underline"
          href={
            subjectHref(
              {
                id: verification.catalogueSubjectId,
                label: subjectLabel(subjectTitle, verification.catalogueSubjectId),
              },
              getLocale(),
            ).href
          }
        >
          {m.settings_verification_view_agent()}
        </a>
      </p>
    );
  if (verification.state === 'rejected')
    return <p>{m.settings_verification_rejected({ reason: verification.reason ?? '' })}</p>;
  if (verification.state === 'withdrawn') return <p>{m.settings_verification_withdrawn()}</p>;
  if (verification.state === 'failed') return <p>{m.settings_verification_failed()}</p>;
  return null;
}

export function VerificationSection() {
  const { state, csrfToken, subject } = useSettingsSession();
  const admitted = useSettingsOperation('agent_verification.request');
  if (!admitted || state !== 'signed-in' || !subject) return null;
  return <ViewerVerification key={JSON.stringify([subject, csrfToken])} accountId={subject} csrfToken={csrfToken} />;
}

/** Original credentials and a guarded query producer prevent late reads from entering another owner's cache. */
export function verificationRecoveryIO(
  owner: SettingsSessionOwner,
  client: QueryClient,
  ambient: SettingsAmbient,
  transport = {
    read: (accountId: string, signal?: AbortSignal) =>
      readVerificationState({ data: { accountId }, ...(signal ? { signal } : {}) }).then((result) =>
        unwrapVerificationRead<VerificationSnapshot>(result),
      ),
    request: (accountId: string, input: VerificationInput, token: string, signal?: AbortSignal) =>
      requestVerificationAction({
        data: { ...input, accountId },
        ...(signal ? { signal } : {}),
        headers: { 'X-CSRF-Token': token },
      }),
    withdraw: (accountId: string, input: { idempotencyKey: string }, token: string, signal?: AbortSignal) =>
      withdrawVerificationAction({
        data: { ...input, accountId },
        ...(signal ? { signal } : {}),
        headers: { 'X-CSRF-Token': token },
      }),
  },
  isCurrent: () => boolean = owner.readCurrent,
): VerificationRecoveryIO {
  const guard = async <T,>(dispatch: (token: string) => Promise<T>): Promise<T> => {
    if (!isCurrent()) throw new Error('Settings viewer unavailable');
    const result = await owner.guard(dispatch);
    if (!isCurrent()) throw new Error('Settings viewer changed');
    return result;
  };
  const readGuard = async <T,>(dispatch: () => Promise<T>): Promise<T> => {
    if (!isCurrent()) throw new Error('Settings viewer unavailable');
    const result = await owner.guardRead(dispatch);
    if (!isCurrent()) throw new Error('Settings viewer changed');
    return result;
  };
  const key = verificationQueryKey(owner.subject);
  const lifetime = new AbortController();
  const scope = (signal?: AbortSignal) => (signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal);
  // This subscription owns only the original query, and runs synchronously on retirement.
  const release = owner.subscribe(() => {
    if (owner.readCurrent()) return;
    release();
    lifetime.abort();
    void client.cancelQueries({ queryKey: key, exact: true });
    client.removeQueries({ queryKey: key, exact: true });
  });
  return {
    read: (accountId, caller) =>
      readGuard(async () => {
        if (accountId !== owner.subject) throw new Error('Verification account changed');
        // A status read begun before this action cannot serve as its authoritative readback.
        await client.cancelQueries({ queryKey: key, exact: true });
        if (!isCurrent()) throw new Error('Settings viewer changed');
        return client.fetchQuery({
          ...productionSettingsShellPort.personalRead,
          queryKey: key,
          queryFn: ({ signal }) =>
            readGuard(async () => {
              const result = await withVerificationDeadline(
                (child) => transport.read(accountId, child),
                AbortSignal.any([signal, scope(caller)]),
                ambient.timer,
              );
              if (
                result.accountId !== owner.subject ||
                (result.verificationRequest && result.verificationRequest.accountId !== owner.subject)
              )
                throw new Error('Verification account changed');
              return result;
            }),
          staleTime: 0,
          retry: false,
        });
      }),
    request: (accountId, input, caller) =>
      guard((token) => {
        if (accountId !== owner.subject) throw new Error('Verification account changed');
        return withVerificationDeadline(
          (signal) => transport.request(accountId, input, token, signal),
          scope(caller),
          ambient.timer,
        );
      }),
    withdraw: (accountId, input, caller) =>
      guard((token) => {
        if (accountId !== owner.subject) throw new Error('Verification account changed');
        return withVerificationDeadline(
          (signal) => transport.withdraw(accountId, input, token, signal),
          scope(caller),
          ambient.timer,
        );
      }),
  };
}

function ViewerVerification({ accountId, csrfToken }: { accountId: string; csrfToken: string | null }) {
  const queryClient = useQueryClient();
  const ambient = useSettingsAmbient();
  const owner = useSettingsSessionOwner(csrfToken, accountId)!;
  const isCurrent = useSettingsLiveness(owner.readCurrent);
  const verification = useVerification();
  const [controller] = useState(() =>
    verification.application.recover(
      accountId,
      verificationRecoveryIO(owner, queryClient, ambient, undefined, isCurrent),
      isCurrent,
      () => isCurrent() && owner.isCurrent(),
    ),
  );
  const dispose = useCallback(() => controller.deactivate(), [controller]);
  useSettingsDisposal(dispose);
  useEffect(() => {
    void controller.reload();
  }, [controller]);
  return <VerificationCard controller={controller} csrfToken={csrfToken} />;
}

type VerificationDraft = {
  selected: { id: string; title: string; type: string } | null;
  statement: string;
  links: { label: string; url: string }[];
};

/** The production card and recovery stories use the same controller and controls. */
export function VerificationCard({
  controller,
  csrfToken,
  initialDraft,
}: {
  controller: VerificationRecovery;
  csrfToken: string | null;
  initialDraft?: VerificationDraft | undefined;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const id = useId();
  const [selected, setSelected] = useState<VerificationDraft['selected']>(initialDraft?.selected ?? null);
  const [statement, setStatement] = useState(initialDraft?.statement ?? '');
  const [links, setLinks] = useState<VerificationLinkRow[]>(() =>
    (initialDraft?.links ?? [{ label: '', url: '' }]).map((link, key) => ({ ...link, key })),
  );
  const form = useRef<HTMLFormElement>(null);
  const [showValidation, setShowValidation] = useState(false);
  // Confirmation belongs to this request identity, state, and advice; a newer observation needs a fresh decision.
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [focusIntent, setFocusIntent] = useState<VerificationPresentationFocusIntent | null>(null);
  const focusIntentRef = useRef<VerificationPresentationFocusIntent | null>(null);
  const nextFocusIntent = useRef(0);
  const currentOutcome = useRef<HTMLDivElement>(null);
  // Capture the genuine label in the action handler, before a send clears current status or the draft changes.
  const [action, setAction] = useState<{ kind: 'request' | 'withdraw'; subject: string } | null>(null);
  const [acknowledged, setAcknowledged] = useState<Omit<VerificationInput, 'idempotencyKey'> | null>(null);
  const verificationCapability = useVerification();
  const isCurrent = useSettingsReadCurrent(csrfToken, true);
  const pending = state.phase === 'sending' || state.phase === 'reading';
  const commandWaiting = usePreferenceRetry(state.failure, state.commandRetryAt);
  const readWaiting = usePreferenceRetry(state.failure, state.readRetryAt);
  const verification = state.current?.verificationRequest ?? null;
  const subjectTitle = state.current?.subjectTitle ?? null;
  const observation = verificationWithdrawalObservation(state.current);
  const canRequest =
    canRequestVerification(state.current) && !state.attempt && !pending && !commandWaiting && !!csrfToken;
  const canWithdraw =
    canWithdrawVerification(state.current) &&
    !!verification &&
    !state.attempt &&
    !pending &&
    !commandWaiting &&
    !!csrfToken;
  const hasDraft = !!selected || !!statement || links.some((link) => link.label || link.url);

  function cancelFocusIntent(id?: number) {
    const active = focusIntentRef.current;
    if (!active || (id !== undefined && active.id !== id)) return;
    focusIntentRef.current = null;
    setFocusIntent(null);
  }

  function beginFocusIntent(
    kind: VerificationPresentationFocusIntent['kind'],
    snapshot: VerificationRecoveryState,
    currentObservation: string | null,
    ready: boolean,
  ) {
    cancelFocusIntent();
    const intent: VerificationPresentationFocusIntent = {
      id: ++nextFocusIntent.current,
      kind,
      accountId: controller.accountId,
      observation: currentObservation,
      snapshot,
      ready,
    };
    focusIntentRef.current = intent;
    setFocusIntent(intent);
    return intent.id;
  }

  function completeFocusIntent(id: number, snapshot: VerificationRecoveryState) {
    const active = focusIntentRef.current;
    if (!active || active.id !== id) return;
    if (!isCurrent() || active.accountId !== controller.accountId) {
      cancelFocusIntent(id);
      return;
    }
    const completed = {
      ...active,
      ready: true,
      snapshot,
      observation: verificationWithdrawalObservation(snapshot.current),
    };
    focusIntentRef.current = completed;
    setFocusIntent(completed);
  }

  useLayoutEffect(() => {
    if (!focusIntent || focusIntent.ready) return;
    const doc = currentOutcome.current?.ownerDocument;
    if (!doc) {
      cancelFocusIntent(focusIntent.id);
      return;
    }
    const cancelForManualChoice = () => cancelFocusIntent(focusIntent.id);
    doc.addEventListener('pointerdown', cancelForManualChoice, true);
    doc.addEventListener('keydown', cancelForManualChoice, true);
    doc.addEventListener('focusin', cancelForManualChoice, true);
    return () => {
      doc.removeEventListener('pointerdown', cancelForManualChoice, true);
      doc.removeEventListener('keydown', cancelForManualChoice, true);
      doc.removeEventListener('focusin', cancelForManualChoice, true);
    };
  }, [focusIntent]);

  useLayoutEffect(() => {
    if (!focusIntent?.ready || focusIntentRef.current?.id !== focusIntent.id) return;
    const latest = controller.snapshot();
    const latestObservation = verificationWithdrawalObservation(latest.current);
    const currentBelongsToAccount =
      (!latest.current || latest.current.accountId === focusIntent.accountId) &&
      (!latest.current?.verificationRequest || latest.current.verificationRequest.accountId === focusIntent.accountId);
    const currentIntent =
      isCurrent() &&
      controller.accountId === focusIntent.accountId &&
      latest === state &&
      latest === focusIntent.snapshot &&
      currentBelongsToAccount &&
      latestObservation === focusIntent.observation;
    const doc = currentOutcome.current?.ownerDocument;
    const target = (name: string) => doc?.getElementById(`${id}-verification-${name}`) ?? null;
    let destination: HTMLElement | null = null;

    if (currentIntent) {
      if (focusIntent.kind === 'confirmation-open') {
        if (confirmation === focusIntent.observation && observation === focusIntent.observation && canWithdraw)
          destination = target('confirmation-heading');
      } else if (focusIntent.kind === 'confirmation-cancel') {
        if (confirmation === null && observation === focusIntent.observation && canWithdraw)
          destination = target('withdraw');
      } else if (state.attempt) {
        const retry = target('retry');
        if (
          !state.attempt.receipt &&
          retry &&
          'disabled' in retry &&
          !retry.disabled &&
          visibleFocusTarget(retry)
        )
          destination = retry;
        else destination = target('recovery-heading');
      } else if (state.phase === 'refused') destination = target('refused-outcome');
      else if (state.readStatus === 'error') destination = target('read-outcome');
      else destination = target('current-outcome');
    }

    cancelFocusIntent(focusIntent.id);
    if (currentIntent && visibleFocusTarget(destination)) destination?.focus();
  }, [focusIntent, state, confirmation, observation, canWithdraw, controller, id, isCurrent]);

  // Wholly empty optional rows remain editable placeholders, as before. Every populated byte stays in order.
  const populated = links.filter((link) => link.label || link.url);
  const draft = {
    subject: selected?.id ?? '',
    statement,
    links: populated.map(({ label, url }) => ({ label, url })),
  };
  useSettingsNavigationDraft(
    'verification',
    isCurrent() && verificationNeedsNavigationDecision(state, draft, acknowledged),
    () => isCurrent() && verificationNeedsNavigationDecision(controller.snapshot(), draft, acknowledged),
    controller,
  );
  const issues = showValidation ? validateVerificationDraft(draft) : [];
  function fieldId(issue: VerificationIssue) {
    if (issue.field === 'label' || issue.field === 'url') return `${id}-${issue.field}-${populated[issue.index!]!.key}`;
    return issue.field === 'links' ? `${id}-add-link` : `${id}-${issue.field}`;
  }
  const errors = new Map(issues.map((issue) => [fieldId(issue), verificationIssueMessage(issue)]));
  function focusField(target: string) {
    if (target === `${id}-subject`) form.current?.querySelector<HTMLInputElement>('[role="combobox"]')?.focus();
    else form.current?.ownerDocument.getElementById(target)?.focus();
  }

  async function recover(kind: 'request' | 'withdraw' | 'retry' | 'read-current', action: () => Promise<void>) {
    if (!isCurrent()) return;
    const before = controller.snapshot();
    const focusId = beginFocusIntent('result', before, verificationWithdrawalObservation(before.current), false);
    const command = action();
    const started = controller.snapshot();
    const original = started.attempt;
    const originalKey = original?.input.idempotencyKey;
    const dispatched =
      kind === 'read-current'
        ? started !== before && started.phase === 'reading' && started.readStatus === 'reading'
        : started.phase === 'sending' &&
          !!original &&
          (kind === 'request'
            ? original.kind === 'request'
            : kind === 'withdraw'
              ? original.kind === 'withdraw'
              : before.attempt?.input.idempotencyKey === originalKey);
    if (!dispatched) {
      cancelFocusIntent(focusId);
      await command;
      return;
    }
    await command;
    if (!isCurrent()) {
      cancelFocusIntent(focusId);
      return;
    }
    const current = controller.snapshot();
    const terminal = current !== started && current.phase !== 'sending' && current.phase !== 'reading';
    const sameAttempt = !!originalKey && current.attempt?.input.idempotencyKey === originalKey;
    const replacement =
      kind === 'read-current'
        ? current.readStatus === 'success' || current.readStatus === 'error'
        : sameAttempt || (!current.attempt && (current.phase === 'review' || current.phase === 'refused'));
    if (terminal && replacement) completeFocusIntent(focusId, current);
    else cancelFocusIntent(focusId);
    if (original?.kind === 'request' && !current.attempt && current.phase === 'review') setAcknowledged(original.input);
  }

  async function submit() {
    if (!isCurrent() || !csrfToken || !canRequest) return;
    const invalid = validateVerificationDraft(draft);
    setShowValidation(true);
    if (invalid.length) {
      focusField(fieldId(invalid[0]!));
      return;
    }
    setAction({ kind: 'request', subject: subjectLabel(selected?.title, selected?.id) });
    await recover('request', () => controller.submit(draft));
  }

  async function withdraw() {
    if (!isCurrent() || !csrfToken || confirmation === null || confirmation !== observation || !canWithdraw) return;
    setAction({ kind: 'withdraw', subject: subjectLabel(subjectTitle, verification?.catalogueSubjectId) });
    await recover('withdraw', () => controller.withdraw(true));
    if (isCurrent()) setConfirmation(null);
  }

  function openConfirmation() {
    const latest = controller.snapshot();
    if (
      !isCurrent() ||
      latest !== state ||
      !observation ||
      verificationWithdrawalObservation(latest.current) !== observation ||
      !canWithdraw
    )
      return;
    beginFocusIntent('confirmation-open', latest, observation, true);
    setConfirmation(observation);
  }

  function cancelConfirmation() {
    const latest = controller.snapshot();
    if (
      !isCurrent() ||
      latest !== state ||
      confirmation === null ||
      confirmation !== observation ||
      verificationWithdrawalObservation(latest.current) !== observation ||
      !canWithdraw
    ) {
      cancelFocusIntent();
      setConfirmation(null);
      return;
    }
    beginFocusIntent('confirmation-cancel', latest, observation, true);
    setConfirmation(null);
  }

  return (
    <ContentSection className="min-w-0">
      <ContentSectionHeader>
        <ContentSectionTitle>
          <h2>{m.settings_verification_heading()}</h2>
        </ContentSectionTitle>
        <ContentSectionDescription>{m.settings_verification_intro()}</ContentSectionDescription>
      </ContentSectionHeader>
      <ContentSectionBody className="min-w-0 space-y-4">
        <div
          ref={currentOutcome}
          id={`${id}-verification-current-outcome`}
          tabIndex={-1}
          className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {state.phase === 'loading' || state.readStatus === 'reading' ? (
            <p>{m.settings_verification_loading()}</p>
          ) : state.readStatus === 'success' && !verification ? (
            <p>{m.settings_verification_read_empty()}</p>
          ) : (
            <VerificationState verification={verification} subjectTitle={subjectTitle} />
          )}
        </div>
        {verification && state.readStatus === 'success' ? (
          <div className="space-y-2 break-words">
            <p className="whitespace-pre-wrap">{verification.statement}</p>
            {verification.links.length ? (
              <ul>
                {verification.links.map((link, index) => (
                  <li key={index}>
                    {link.label}: {link.url}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {state.phase === 'sending' ? <p role="status">{m.settings_saving()}</p> : null}
        {state.readStatus === 'error' ? (
          <div
            role="alert"
            data-response-status={state.failure?.status}
            data-response-code={diagnosticCode(state.failure?.code)}
            data-request-id={boundedDiagnosticId(state.failure?.requestId)}
            data-retry-after={diagnosticRetryAfter(state.failure?.retryAfter)}
          >
            <p
              id={`${id}-verification-read-outcome`}
              tabIndex={-1}
              className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {m.settings_verification_load_failed()}{' '}
              {state.failure?.code === 'platform_closed' || state.failure?.message === 'rezics-platform-closed'
                ? m.settings_verification_read_closed()
                : state.failure?.status === 401 || state.failure?.status === 403
                  ? m.settings_verification_read_denied()
                  : m.settings_verification_read_unavailable()}
            </p>
            {state.failure ? (
              <details>
                <summary className={verificationSummaryClassName}>{m.settings_verification_read_details()}</summary>
                <p>{m.settings_verification_read_error({ status: state.failure.status })}</p>
              </details>
            ) : null}
          </div>
        ) : null}
        {canRequest || hasDraft ? (
          <form
            ref={form}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="space-y-4"
          >
            {issues.length ? (
              <Alert role="alert">
                <AlertTitle>{m.settings_verification_fix_fields()}</AlertTitle>
                <AlertDescription>
                  <ul>
                    {issues.map((issue) => (
                      <li key={fieldId(issue)}>
                        <a
                          className="flex items-center underline"
                          href={`#${fieldId(issue)}`}
                          onClick={(event) => {
                            event.preventDefault();
                            focusField(fieldId(issue));
                          }}
                        >
                          {issue.index === undefined
                            ? verificationIssueMessage(issue)
                            : m.settings_verification_link_issue({
                                number: links.indexOf(populated[issue.index]!) + 1,
                                message: verificationIssueMessage(issue),
                              })}
                        </a>
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
            <FieldGroup>
              <VerificationSubjectChooser
                owner={verificationCapability.ownerKey(controller.accountId, csrfToken)}
                selected={selected}
                onSelect={(subject) => {
                  setSelected(subject);
                  cancelFocusIntent();
                  setConfirmation(null);
                }}
                disabled={pending || !csrfToken}
                search={verificationCapability.search}
              />
              <Field data-invalid={errors.has(`${id}-statement`)}>
                <FieldLabel htmlFor={`${id}-statement`}>{m.settings_verification_statement()}</FieldLabel>
                <Textarea
                  id={`${id}-statement`}
                  value={statement}
                  aria-invalid={errors.has(`${id}-statement`)}
                  aria-describedby={`${id}-statement-count${errors.has(`${id}-statement`) ? ` ${id}-statement-error` : ''}`}
                  onChange={(event) => setStatement(event.target.value)}
                />
                <FieldDescription id={`${id}-statement-count`}>
                  {m.settings_verification_characters({ count: verificationCharacterCount(statement) })}
                </FieldDescription>
                {errors.has(`${id}-statement`) ? (
                  <FieldDescription id={`${id}-statement-error`} className="text-destructive">
                    {errors.get(`${id}-statement`)}
                  </FieldDescription>
                ) : null}
              </Field>
              <VerificationLinks id={id} rows={links} onChange={setLinks} errors={errors} />
            </FieldGroup>
            <Button
              type="submit"
              className={verificationActionClassName}
              disabled={!csrfToken || !canRequest || pending || !selected}
            >
              {m.settings_verification_submit()}
            </Button>
          </form>
        ) : null}
        {canWithdraw ? (
          confirmation !== null && confirmation === observation ? (
            <Alert>
              <AlertTitle
                id={`${id}-verification-confirmation-heading`}
                tabIndex={-1}
                className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {m.settings_verification_confirm_title()}
              </AlertTitle>
              <AlertDescription className="flex min-w-0 max-w-full flex-wrap gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  className={verificationActionClassName}
                  id={`${id}-verification-confirm`}
                  disabled={pending || !csrfToken}
                  onClick={() => void withdraw()}
                >
                  {m.settings_verification_confirm_withdraw()}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={verificationActionClassName}
                  id={`${id}-verification-cancel`}
                  onClick={cancelConfirmation}
                >
                  {m.settings_verification_cancel()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <Button
              type="button"
              variant="outline"
              className={verificationActionClassName}
              id={`${id}-verification-withdraw`}
              onClick={openConfirmation}
            >
              {m.settings_verification_withdraw()}
            </Button>
          )
        ) : null}
        {state.attempt && !pending ? (
          <Alert>
            <AlertTitle
              id={`${id}-verification-recovery-heading`}
              tabIndex={-1}
              className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {state.attempt.receipt
                ? state.attempt.kind === 'request'
                  ? m.settings_verification_request_received()
                  : m.settings_verification_withdraw_received()
                : state.attempt.kind === 'request'
                  ? m.settings_verification_uncertain_request()
                  : m.settings_verification_uncertain_withdraw()}
            </AlertTitle>
            <AlertDescription className="min-w-0 space-y-3">
              <p>
                {state.attempt.receipt
                  ? m.settings_verification_check_guidance()
                  : state.attempt.kind === 'request'
                    ? m.settings_verification_request_unconfirmed()
                    : m.settings_verification_withdraw_unconfirmed()}
              </p>
              <p>
                {state.attempt.kind === 'request'
                  ? m.settings_verification_request_action({
                      subject: action?.subject ?? m.settings_verification_generic_subject(),
                    })
                  : m.settings_verification_withdraw_action({
                      subject: action?.subject ?? m.settings_verification_generic_subject(),
                    })}
              </p>
              {!state.attempt.receipt ? (
                <>
                  <p>{m.settings_verification_check_guidance()}</p>
                  <p>
                    {state.attempt.kind === 'request'
                      ? m.settings_verification_retry_request_guidance()
                      : m.settings_verification_retry_withdraw_guidance()}
                  </p>
                </>
              ) : null}
              {state.attempt.kind === 'request' ? (
                <details>
                  <summary className={verificationSummaryClassName}>{m.settings_verification_original()}</summary>
                  <div className="space-y-2 break-words">
                    <p className="whitespace-pre-wrap">{state.attempt.input.statement}</p>
                    <ul>
                      {state.attempt.input.links.map((link, index) => (
                        <li key={index}>
                          {link.label}: {link.url}
                        </li>
                      ))}
                    </ul>
                  </div>
                </details>
              ) : boundedDiagnosticId(state.attempt.requestId) ? (
                <details>
                  <summary className={verificationSummaryClassName}>
                    {m.settings_verification_withdraw_details()}
                  </summary>
                  <p className="break-all">{state.attempt.requestId}</p>
                </details>
              ) : null}
              {commandWaiting ? <p role="status">{m.settings_retry_wait()}</p> : null}
              {!state.attempt.receipt ? (
                <Button
                  type="button"
                  className={verificationActionClassName}
                  id={`${id}-verification-retry`}
                  disabled={!canRetryVerification(state.attempt, state.current) || commandWaiting || !csrfToken}
                  onClick={() => void recover('retry', () => controller.retry())}
                >
                  {state.attempt.kind === 'request'
                    ? m.settings_verification_retry_original()
                    : m.settings_verification_retry_withdraw()}
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {state.phase === 'refused' ? (
          <Alert>
            <AlertTitle
              id={`${id}-verification-refused-outcome`}
              tabIndex={-1}
              className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {action?.kind === 'withdraw'
                ? m.settings_verification_withdraw_refused()
                : m.settings_verification_request_refused()}
            </AlertTitle>
            <AlertDescription>
              <p>
                {action?.kind === 'withdraw'
                  ? m.settings_verification_withdraw_action({ subject: action.subject })
                  : m.settings_verification_request_action({
                      subject: action?.subject ?? m.settings_verification_generic_subject(),
                    })}
              </p>
              <p>{m.settings_verification_check_guidance()}</p>
            </AlertDescription>
          </Alert>
        ) : null}
        {state.phase === 'review' ? <p role="status">{m.settings_verification_draft_preserved()}</p> : null}
        {state.failure && state.readStatus !== 'error' ? <CommandDetails failure={state.failure} /> : null}
        {commandWaiting && !state.attempt ? <p role="status">{m.settings_retry_wait()}</p> : null}
        {readWaiting ? <p role="status">{m.settings_retry_wait()}</p> : null}
        <Button
          type="button"
          variant="outline"
          className={verificationActionClassName}
          id={`${id}-verification-read-current`}
          disabled={pending || readWaiting}
          onClick={() => void recover('read-current', () => controller.reload())}
        >
          {m.settings_verification_read_current()}
        </Button>
      </ContentSectionBody>
    </ContentSection>
  );
}
