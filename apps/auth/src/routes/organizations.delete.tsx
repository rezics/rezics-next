import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import { useCallback, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { AuthButton as Button } from '../button';
import { ErrorAlert } from '../alert';
import { AuthPage } from '../frame';
import { OrganizationDeletionDeparturePrompt } from '../organization-deletion-recovery';
import {
  OrganizationDeletionReturnController,
  type OrganizationDeletionHistoryView,
  type OrganizationDeletionReviewGeneration,
} from '../organization-deletion-return';
import { OrganizationDeletionReturnView } from '../organization-deletion-return-view';
import {
  organizationDeletionAttempt,
  warnOrganizationDeletionAttempt,
  type OrganizationDeletionAttempt,
} from '../organization-deletion-attempt';
import { m } from '../paraglide/messages.js';
import { readPrivacyContact } from '../privacy-contact';
import { forgetOperationKey, operationKeyFor } from '../account-operations';
import {
  clearOrganizationDeleteStepUp,
  isAccountId,
  organizationDeletePendingMatches,
  organizationDeleteStepUpUrl,
  readOrganizationDeleteStepUp,
  storeOrganizationDeleteStepUp,
  readOrganizationDeleteUnknown,
} from '../organization-delete-step-up';
import {
  executeOrganizationDeletion,
  loadOrganizationDeletion,
  organizationDeleteConfirmation,
  organizationDeleteConfirmed,
  readCurrentOrganizationForDeletion,
  type OrganizationDeletionLoad,
  type OrganizationDeletionReader,
} from '../organization-deletion';

// Trusted issuer entry for Web management: /organizations/delete?organization_id=<immutable UUID>.
// The selection supplies no authority and is never accepted as an own-delete target.
export const Route = createFileRoute('/organizations/delete')({
  validateSearch: (search: Record<string, unknown>) => ({
    organization_id:
      search.organization_id === undefined
        ? undefined
        : isAccountId(search.organization_id)
          ? search.organization_id
          : '',
  }),
  loader: () => readPrivacyContact(),
  head: () => ({ meta: [{ title: `${m.auth_organization_delete_heading()} · REZICS` }] }),
  component: OrganizationDeletePage,
});

function OrganizationDeleteDeparture({
  shouldWarn,
  leave,
  focus,
  unknown,
}: {
  shouldWarn: () => boolean;
  leave: () => void;
  focus: () => void;
  unknown: boolean;
}) {
  const blocker = useBlocker({ shouldBlockFn: shouldWarn, enableBeforeUnload: false, withResolver: true });
  const staying = useRef(false);
  useLayoutEffect(() => {
    if (blocker.status === 'blocked' && !shouldWarn()) blocker.proceed();
  });
  const stay = () => {
    if (blocker.status === 'blocked') {
      staying.current = true;
      blocker.reset();
    }
  };
  return (
    <OrganizationDeletionDeparturePrompt
      open={blocker.status === 'blocked'}
      unknown={unknown}
      stay={stay}
      focus={() => {
        // Automatic release on replacement/completion must not focus a newer view.
        if (!staying.current) return;
        staying.current = false;
        focus();
      }}
      leave={() => {
        if (blocker.status !== 'blocked') return;
        staying.current = false;
        leave();
        blocker.proceed();
      }}
    />
  );
}

function OrganizationDeletePage() {
  return (
    <OrganizationDeleteContent
      privacyContact={Route.useLoaderData()}
      organizationId={Route.useSearch().organization_id}
    />
  );
}

export function OrganizationDeleteContent({
  privacyContact,
  organizationId,
  read = readCurrentOrganizationForDeletion,
}: {
  privacyContact: string | null;
  organizationId?: string | undefined;
  read?: OrganizationDeletionReader;
}) {
  const [loaded, setLoaded] = useState<OrganizationDeletionLoad | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [confirmationError, setConfirmationError] = useState(false);
  const [pending, setPending] = useState(false);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState<OrganizationDeletionHistoryView>([]);
  const [needsReview, setNeedsReview] = useState(false);
  const submitting = useRef<object | null>(null);
  const attempt = useRef<OrganizationDeletionAttempt | null>(null);
  const [returns] = useState(
    () =>
      new OrganizationDeletionReturnController(setHistory, () => {
        if (attempt.current) attempt.current.unresolved = true;
      }),
  );
  const recoveryHeading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const alert = useRef<HTMLDivElement>(null);
  const router = useRouter({ warn: false });
  const bypassDeparture = useRef(false);
  const nativeFlight = useRef<object | null>(null);
  const focusIntent = useRef<'history' | 'retry' | 'sign-in' | 'confirmation' | null>(null);
  const departureState = useRef({ confirmation, pending, loaded, organizationId, read });
  departureState.current = { confirmation, pending, loaded, organizationId, read };

  const shouldWarn = useCallback(() => {
    const state = departureState.current;
    const current = returns.current;
    const continuation = readOrganizationDeleteStepUp();
    const attemptSelection = current?.selected ?? state.organizationId ?? attempt.current?.identity.organizationId;
    const hasAuthority = state.loaded === null || state.loaded.kind === 'ready' || state.loaded.kind === 'unavailable';
    const unfinished =
      Boolean(state.confirmation.trim()) ||
      state.pending ||
      submitting.current !== null ||
      (continuation.kind === 'pending' &&
        Boolean(current?.humanAccountId && current.selected && current.operationKey) &&
        organizationDeletePendingMatches(
          continuation.value,
          current!.humanAccountId!,
          current!.selected!,
          current!.operationKey!,
        ));
    const activeReviewCanWarn = Boolean(
      current &&
        current.source === state.organizationId &&
        current.reader === state.read &&
        current.active &&
        hasAuthority &&
        unfinished,
    );
    return Boolean(
      !bypassDeparture.current &&
      (warnOrganizationDeletionAttempt(attempt.current, attemptSelection) ||
        activeReviewCanWarn),
    );
  }, []);

  function resetReview(needsCurrentReview = false) {
    submitting.current = null;
    setPending(false);
    setLoaded(null);
    setConfirmationError(false);
    setMessage('');
    setConfirmation('');
    setNeedsReview(needsCurrentReview);
  }

  function acquireNativeFlight(token: object): boolean {
    if (nativeFlight.current) return false;
    nativeFlight.current = token;
    setNativeBusy(true);
    return true;
  }

  function releaseNativeFlight(token: object): void {
    if (nativeFlight.current !== token) return;
    nativeFlight.current = null;
    setNativeBusy(false);
  }

  function retireReview(current: OrganizationDeletionReviewGeneration, result?: OrganizationDeletionLoad) {
    const belongsToAttempt = attempt.current?.identity.organizationId === current.selected;
    const activeAttempt = attempt.current;
    returns.retire(current);
    if (belongsToAttempt && activeAttempt && !activeAttempt.unresolved) {
      activeAttempt.mounted = false;
      attempt.current = null;
    }
    if (!current.active) {
      if (result) setLoaded(result);
      setNeedsReview(true);
    }
    if (returns.current === null) {
      submitting.current = null;
      setPending(false);
    }
  }

  function leaveReview() {
    bypassDeparture.current = true;
    if (attempt.current) attempt.current.mounted = false;
    returns.retire();
    resetReview(true);
  }

  function selectedForReview(): string | undefined {
    if (organizationId !== undefined) return organizationId;
    if (attempt.current?.unresolved) return attempt.current.identity.organizationId;
    const continuation = readOrganizationDeleteStepUp();
    return continuation.kind === 'pending' ? continuation.value.organizationId : undefined;
  }

  function beginReview(selected: string | undefined): OrganizationDeletionReviewGeneration {
    const uncertain = selected ? readOrganizationDeleteUnknown(selected) : { kind: 'absent' as const };
    const continuation = readOrganizationDeleteStepUp();
    const retained = attempt.current?.unresolved && attempt.current.identity.organizationId === selected
      ? attempt.current.identity
      : uncertain.kind === 'pending' && uncertain.value.organizationId === selected
        ? uncertain.value
        : continuation.kind === 'pending' && continuation.value.organizationId === selected
          ? continuation.value
          : undefined;
    return returns.begin({
      selected,
      source: organizationId,
      reader: read,
      humanAccountId: retained?.humanAccountId,
      operationKey: retained?.operationKey,
    });
  }

  function retainUnresolved(selected: string | undefined) {
    if (selected && !attempt.current?.unresolved) {
      const hint = readOrganizationDeleteUnknown(selected);
      attempt.current = organizationDeletionAttempt(
        hint.kind === 'pending' && hint.value.organizationId === selected
          ? hint.value
          : { organizationId: selected },
        true,
      );
    }
    if (!returns.history().includes('unresolved')) returns.seed('unresolved');
  }

  async function loadReview(current: OrganizationDeletionReviewGeneration) {
    const selected = current.selected;
    const reader = current.reader;
    const result = selected && reader
      ? await loadOrganizationDeletion(selected, reader, current)
      : { kind: 'missing' as const };
    if (!current.isCurrent()) return;
    if (['signed-out', 'denied', 'hidden', 'missing', 'changed', 'unavailable'].includes(result.kind)) {
      retireReview(current, result);
      focusIntent.current = result.kind === 'signed-out' ? 'sign-in' : 'retry';
      return;
    }
    const continuation = readOrganizationDeleteStepUp();
    if (
      continuation.kind === 'pending' &&
      continuation.value.organizationId === selected &&
      result.kind === 'ready'
    ) {
      if (
        !organizationDeletePendingMatches(
          continuation.value,
          result.target.humanAccountId,
          result.target.organizationId,
          current.operationKey ?? '',
        )
      ) {
        retireReview(current, { kind: 'changed' });
        setMessage(m.auth_organization_delete_changed());
        focusIntent.current = 'retry';
        return;
      }
      setMessage(m.auth_account_operation_reconfirm());
    }
    setLoaded(result);
    setNeedsReview(false);
    focusIntent.current = result.kind === 'ready' ? 'confirmation' : null;
  }

  function startInitialRead(current: OrganizationDeletionReviewGeneration) {
    const operationToken = {};
    if (!acquireNativeFlight(operationToken)) {
      setNeedsReview(true);
      return;
    }
    submitting.current = operationToken;
    setPending(true);
    void loadReview(current).finally(() => {
      releaseNativeFlight(operationToken);
      if (submitting.current === operationToken) {
        submitting.current = null;
        setPending(false);
      }
    });
  }

  async function reviewCurrent() {
    if (submitting.current || nativeFlight.current || pending) return;
    const current = beginReview(selectedForReview());
    setLoaded(null);
    setConfirmation('');
    setConfirmationError(false);
    setMessage('');
    setNeedsReview(false);
    setPending(true);
    focusIntent.current = null;
    const operationToken = {};
    if (!acquireNativeFlight(operationToken)) return;
    submitting.current = operationToken;
    try {
      await loadReview(current);
    } finally {
      releaseNativeFlight(operationToken);
      if (submitting.current === operationToken) {
        submitting.current = null;
        setPending(false);
      }
    }
  }

  useLayoutEffect(() => {
    returns.retire();
    bypassDeparture.current = false;
    resetReview(false);
    const continuation = readOrganizationDeleteStepUp();
    const saved = continuation.kind === 'pending' ? continuation.value : null;
    const selected = selectedForReview();
    const hint = selected ? readOrganizationDeleteUnknown(selected) : { kind: 'absent' as const };
    const conflictingContinuation = Boolean(saved && organizationId !== undefined && saved.organizationId !== organizationId);
    const uncertain =
      hint.kind !== 'absent' ||
      continuation.kind === 'invalid' ||
      conflictingContinuation ||
      Boolean(attempt.current?.unresolved);
    if (uncertain) {
      retainUnresolved(selected);
    } else if (!attempt.current?.unresolved) {
      attempt.current = selected ? organizationDeletionAttempt({ organizationId: selected }) : null;
    }
    if (continuation.kind === 'invalid' || (saved && organizationId !== undefined && saved.organizationId !== organizationId)) {
      setMessage(m.auth_organization_delete_changed());
    }
    const current = beginReview(selected);
    const mustReadDeliberately = uncertain || returns.history().length > 0;
    if (mustReadDeliberately) {
      setNeedsReview(true);
      setPending(false);
    } else {
      startInitialRead(current);
    }
    const retire = () => {
      flushSync(() => {
        returns.retire();
        if (attempt.current && !attempt.current.unresolved) {
          attempt.current.mounted = false;
          attempt.current = null;
        }
        resetReview(true);
        focusIntent.current = returns.history().length ? 'history' : 'retry';
      });
    };
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      flushSync(() => {
        returns.retire();
        beginReview(selectedForReview());
        resetReview(true);
        focusIntent.current = returns.history().length ? 'history' : 'retry';
      });
    };
    window.addEventListener('pagehide', retire);
    window.addEventListener('pageshow', restore);
    return () => {
      if (attempt.current && !attempt.current.unresolved) {
        attempt.current.mounted = false;
        attempt.current = null;
      }
      returns.retire();
      window.removeEventListener('pagehide', retire);
      window.removeEventListener('pageshow', restore);
    };
  }, [organizationId, read]);

  useLayoutEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!shouldWarn()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [shouldWarn]);

  const recover = () => void reviewCurrent();

  const hasUnresolvedHistory = history.includes('unresolved');
  const target = loaded?.kind === 'ready' && !hasUnresolvedHistory ? loaded.target : null;
  const phrase = target ? organizationDeleteConfirmation(target, m.auth_organization_delete_phrase()) : '';

  function clearReviewContinuationFor(humanAccountId: string, selected: string, operationKey: string) {
    const saved = readOrganizationDeleteStepUp();
    if (
      saved.kind === 'pending' &&
      organizationDeletePendingMatches(saved.value, humanAccountId, selected, operationKey)
    )
      clearOrganizationDeleteStepUp();
  }

  function authenticate(humanAccountId: string, selected: string) {
    const current = returns.current;
    if (
      !current?.isCurrent() ||
      current.selected !== selected ||
      current.humanAccountId !== humanAccountId ||
      history.includes('unresolved')
    )
      return;
    // Unknown work is never replaced by a new authentication continuation.
    if (readOrganizationDeleteUnknown(selected).kind !== 'absent') {
      setConfirmation('');
      retainUnresolved(selected);
      retireReview(current);
      setNeedsReview(true);
      return;
    }
    const continuation = readOrganizationDeleteStepUp();
    if (continuation.kind === 'invalid') {
      retainUnresolved(current.selected);
      retireReview(current, { kind: 'changed' });
      setConfirmation('');
      setMessage(m.auth_organization_delete_changed());
      focusIntent.current = 'retry';
      return;
    }
    let key = current.operationKey;
    if (continuation.kind === 'pending') {
      if (
        continuation.value.humanAccountId !== humanAccountId ||
        continuation.value.organizationId !== selected ||
        (key !== undefined && continuation.value.operationKey !== key)
      ) {
        retireReview(current, { kind: 'changed' });
        setConfirmation('');
        setMessage(m.auth_organization_delete_changed());
        focusIntent.current = 'retry';
        return;
      }
      key ??= continuation.value.operationKey;
    }
    key ??= operationKeyFor({ kind: 'delete', accountId: selected }, humanAccountId);
    current.operationKey = key;
    if (!storeOrganizationDeleteStepUp({ humanAccountId, organizationId: selected, operationKey: key })) {
      setMessage(m.auth_account_operation_unavailable());
      return;
    }
    setConfirmation('');
    setLoaded(null);
    retireReview(current);
    bypassDeparture.current = true;
    window.location.assign(organizationDeleteStepUpUrl);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = returns.current;
    if (
      !current?.isCurrent() ||
      !target ||
      !privacyContact ||
      submitting.current ||
      nativeFlight.current ||
      history.includes('unresolved')
    ) return;
    if (!organizationDeleteConfirmed(confirmation, phrase)) {
      setConfirmationError(true);
      return;
    }
    const continuation = readOrganizationDeleteStepUp();
    if (continuation.kind === 'invalid') {
      retainUnresolved(selectedForReview());
      retireReview(current, { kind: 'changed' });
      setConfirmation('');
      setMessage(m.auth_organization_delete_changed());
      focusIntent.current = 'retry';
      return;
    }
    const selected = target.organizationId;
    const unknown = readOrganizationDeleteUnknown(selected);
    if (unknown.kind !== 'absent') {
      retainUnresolved(selected);
      retireReview(current);
      setConfirmation('');
      setNeedsReview(true);
      focusIntent.current = 'history';
      return;
    }
    let key = current.operationKey;
    if (continuation.kind === 'pending') {
      if (
        continuation.value.humanAccountId !== target.humanAccountId ||
        continuation.value.organizationId !== selected ||
        (key !== undefined && continuation.value.operationKey !== key)
      ) {
        retainUnresolved(selected);
        retireReview(current, { kind: 'changed' });
        setConfirmation('');
        setMessage(m.auth_organization_delete_changed());
        focusIntent.current = 'retry';
        return;
      }
      key ??= continuation.value.operationKey;
    }
    key ??= operationKeyFor({ kind: 'delete', accountId: selected }, target.humanAccountId);
    current.operationKey = key;
    const attemptId = returns.beginAttempt(current);
    if (attemptId === null) return;
    const operationToken = {};
    if (!acquireNativeFlight(operationToken)) return;
    submitting.current = operationToken;
    setPending(true);
    setConfirmationError(false);
    setMessage('');
    try {
      const operation = { kind: 'delete' as const, accountId: target.organizationId };
      attempt.current = organizationDeletionAttempt({
        organizationId: target.organizationId,
        humanAccountId: target.humanAccountId,
        operationKey: key,
      });
      const result = await executeOrganizationDeletion(target, key, read, current);
      if (result.ok) {
        returns.resolveAttempt(attemptId, 'acknowledged');
        focusIntent.current = 'history';
        forgetOperationKey(operation, target.humanAccountId);
        clearReviewContinuationFor(target.humanAccountId, target.organizationId, key);
        if (attempt.current?.identity.operationKey === key && attempt.current.identity.organizationId === target.organizationId) {
          attempt.current.unresolved = false;
          attempt.current.mounted = false;
          attempt.current = null;
        }
        setConfirmation('');
        if (current.isCurrent()) {
          returns.retire(current);
          setLoaded(null);
          setNeedsReview(true);
          setMessage('');
          focusIntent.current = 'history';
        }
        return;
      }
      const phase = returns.attemptPhase(attemptId);
      if (!current.isCurrent()) {
        if (result.reason === 'unknown') {
          focusIntent.current = 'history';
          if (phase === 'unsent') {
            returns.finishUnsentAttempt(attemptId);
            if (!returns.history().includes('unresolved')) returns.seed('unresolved');
          } else returns.markAttemptUnresolved(attemptId);
        }
        else if (phase === 'unresolved') returns.resolveAttempt(attemptId, 'refused');
        else if (phase === 'unsent' && result.reason !== 'step-up') returns.finishUnsentAttempt(attemptId);
        if (result.reason !== 'unknown' && attempt.current?.identity.operationKey === key) {
          attempt.current.unresolved = false;
          attempt.current.mounted = false;
          attempt.current = null;
        }
        return;
      }
      if (result.reason === 'step-up') {
        authenticate(target.humanAccountId, target.organizationId);
        return;
      }
      if (phase === 'unsent') {
        returns.finishUnsentAttempt(attemptId);
        if (result.reason === 'unknown' && !returns.history().includes('unresolved')) returns.seed('unresolved');
      }
      setConfirmation('');
      if (result.reason === 'unknown') {
        if (phase !== 'unsent') returns.markAttemptUnresolved(attemptId);
        const retained = readOrganizationDeleteUnknown(target.organizationId);
        if (retained.kind === 'pending' && retained.value.organizationId === target.organizationId)
          attempt.current = organizationDeletionAttempt(retained.value, true);
        else if (attempt.current) attempt.current.unresolved = true;
        retireReview(current);
        setLoaded(null);
        setNeedsReview(true);
        setMessage('');
        focusIntent.current = 'history';
      } else if (result.reason === 'changed') {
        if (phase === 'unresolved') returns.resolveAttempt(attemptId, 'refused');
        retireReview(current, { kind: 'changed' });
        clearReviewContinuationFor(target.humanAccountId, target.organizationId, key);
        setMessage(m.auth_organization_delete_changed());
        focusIntent.current = 'retry';
      } else if (result.reason === 'denied') {
        if (phase === 'unresolved') returns.resolveAttempt(attemptId, 'refused');
        retireReview(current, { kind: 'denied' });
        setMessage(m.auth_organization_delete_denied());
        focusIntent.current = 'retry';
      } else if (result.reason === 'platform-closed') {
        setMessage(m.auth_organization_not_open());
        focusIntent.current = 'retry';
      } else if (result.reason === 'unavailable') {
        if (phase === 'unresolved') returns.resolveAttempt(attemptId, 'refused');
        retireReview(current, { kind: 'unavailable' });
        setMessage(m.auth_account_operation_unavailable());
        focusIntent.current = 'retry';
      } else {
        if (phase === 'unresolved') returns.resolveAttempt(attemptId, 'refused');
        setMessage(m.auth_account_operation_failure());
        focusIntent.current = 'retry';
      }
    } finally {
      releaseNativeFlight(operationToken);
      if (submitting.current === operationToken) {
        submitting.current = null;
        setPending(false);
      }
    }
  }

  useLayoutEffect(() => {
    if (confirmationError) input.current?.focus();
    else if (focusIntent.current === 'history') recoveryHeading.current?.focus();
    else if (focusIntent.current === 'retry') document.getElementById('organization-delete-return-review')?.focus();
    else if (focusIntent.current === 'sign-in') document.getElementById('organization-delete-return-sign-in')?.focus();
    else if (focusIntent.current === 'confirmation' && target) input.current?.focus();
    else if (message) alert.current?.focus();
    focusIntent.current = null;
  }, [confirmationError, message, target, loaded, pending, history]);

  const [privacyBefore, privacyAfter] = privacyContact
    ? m.auth_account_delete_privacy_contact({ contact: privacyContact }).split(privacyContact)
    : [];
  const departure = router ? (
    <OrganizationDeleteDeparture
      shouldWarn={shouldWarn}
      leave={leaveReview}
      unknown={hasUnresolvedHistory}
      focus={() => {
        if (bypassDeparture.current) return;
        if (hasUnresolvedHistory || needsReview) recoveryHeading.current?.focus();
        else if (loaded?.kind === 'signed-out') document.getElementById('organization-delete-return-sign-in')?.focus();
        else if (loaded && loaded.kind !== 'ready' && loaded.kind !== 'authentication-required')
          document.getElementById('organization-delete-return-review')?.focus();
        else if (returns.current?.isCurrent() && target) input.current?.focus();
      }}
    />
  ) : null;

  return (
    <AuthPage heading={m.auth_organization_delete_heading()} returnToSecurity>
      {departure}
      <div className="auth-login-form">
        <p>{m.auth_organization_delete_effect()}</p>
        <p>{m.auth_organization_delete_remedies()}</p>
        <p>{m.auth_account_delete_retention_limits()}</p>
        {privacyContact ? (
          <p>
            {privacyBefore}
            <a href={privacyContact}>{privacyContact}</a>
            {privacyAfter}
          </p>
        ) : (
          <ErrorAlert>{m.auth_account_delete_unavailable()}</ErrorAlert>
        )}
        {message ? (
          <ErrorAlert tabIndex={-1} ref={alert}>
            {message}
          </ErrorAlert>
        ) : null}
        <OrganizationDeletionReturnView
          history={history}
          advice={loaded}
          pending={pending}
          readCurrent={nativeBusy ? undefined : recover}
          headingRef={recoveryHeading}
        />
        {hasUnresolvedHistory ? null : !loaded ? (
          pending ? (
            <p role="status">{m.auth_inventory_loading()}</p>
          ) : needsReview ? (
            <>
              <p role="status">{m.auth_organization_delete_return_review_required()}</p>
              <Button
                id="organization-delete-return-review"
                type="button"
                disabled={pending || nativeBusy}
                aria-busy={pending}
                onClick={recover}
              >
                {m.auth_organization_delete_readback()}
              </Button>
            </>
          ) : (
            <p role="status">{m.auth_inventory_loading()}</p>
          )
        ) : loaded.kind === 'signed-out' ? (
          <>
            <p>{m.auth_account_operation_sign_in_required()}</p>
            <a id="organization-delete-return-sign-in" href="/login">{m.auth_security_sign_in()}</a>
            <Button
              id="organization-delete-return-review"
              type="button"
              disabled={pending || nativeBusy}
              aria-busy={pending}
              onClick={recover}
            >
              {m.auth_organization_delete_readback()}
            </Button>
          </>
        ) : loaded.kind === 'authentication-required' ? (
          <>
            <p>{m.auth_transfer_acting_as({ account: loaded.humanAccountId })}</p>
            <p className="break-all">{returns.current?.selected}</p>
            <p>{m.auth_organization_delete_authentication_required()}</p>
            <Button type="button" onClick={() => authenticate(loaded.humanAccountId, returns.current?.selected ?? '')}>
              {m.auth_organization_delete_authenticate()}
            </Button>
          </>
        ) : !target ? (
          <>
            <ErrorAlert>
              {loaded.kind === 'changed'
                ? m.auth_organization_delete_changed()
                : loaded.kind === 'denied'
                  ? m.auth_organization_delete_recovery_denied()
                  : loaded.kind === 'hidden'
                    ? m.auth_organization_delete_recovery_hidden()
                    : loaded.kind === 'missing'
                      ? m.auth_organization_delete_recovery_missing()
                  : m.auth_account_operation_unavailable()}
            </ErrorAlert>
            <Button
              id="organization-delete-return-review"
              type="button"
              disabled={pending || nativeBusy}
              aria-busy={pending}
              onClick={recover}
            >
              {m.auth_organization_delete_readback()}
            </Button>
          </>
        ) : (
          <form
            method="post"
            action="/account-operations/approve"
            onSubmit={submit}
            noValidate
            className="auth-login-form"
          >
            <p className="break-all">{m.auth_transfer_acting_as({ account: target.humanAccountId })}</p>
            <p>{m.auth_organization_delete_advice()}</p>
            <p className="break-words">
              {target.displayName || (target.handle ? `@${target.handle}` : target.organizationId)}
            </p>
            <p className="break-all">{target.organizationId}</p>
            <Field data-invalid={confirmationError}>
              <FieldLabel htmlFor="organization-delete-confirmation">
                {m.auth_account_delete_confirmation_prompt({ phrase })}
              </FieldLabel>
              <Input
                id="organization-delete-confirmation"
                ref={input}
                value={confirmation}
                autoComplete="off"
                required
                readOnly={pending}
                onChange={(event) => {
                  setConfirmation(event.target.value);
                  setConfirmationError(false);
                }}
                aria-invalid={confirmationError || undefined}
                aria-describedby={confirmationError ? 'organization-delete-confirmation-error' : undefined}
              />
              {confirmationError ? (
                <FieldError id="organization-delete-confirmation-error">
                  {m.auth_account_delete_confirmation_error()}
                </FieldError>
              ) : null}
            </Field>
            <Button type="submit" variant="destructive" disabled={pending || !privacyContact} aria-busy={pending}>
              {m.auth_organization_delete_heading()}
            </Button>
          </form>
        )}
      </div>
    </AuthPage>
  );
}
