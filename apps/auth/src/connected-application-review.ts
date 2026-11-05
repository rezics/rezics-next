import { useLayoutEffect, useRef, useState, type Ref } from 'react';
import { m } from './paraglide/messages.js';
import {
  createConsentReduction,
  loadInventory,
  reduceConsent,
  type ConsentOperationBoundary,
  type ConsentReductionResult,
  type ConsentReviewOperation,
  type GrantedConsent,
  type InventoryPage,
} from './security-inventory';

type InventorySource = typeof loadInventory;
type ReviewPhase = 'idle' | 'review' | 'submitting' | 'unknown';
type NavigationDirection = 'next' | 'previous' | 'reload' | 'first';
type NavigationTransition = { target?: string; direction: NavigationDirection };
const MAX_CURSOR_HISTORY = 32;

export type ConnectedApplicationSelection = { consent: GrantedConsent; retained: string[]; confirming: boolean };
export type ConnectedApplicationReviewOptions = {
  source?: InventorySource;
  preflight?: boolean;
  operation?: ConsentOperationBoundary;
  onSessionEnded?: () => void;
  lifetime?: AbortSignal;
};
export type ConnectedApplicationReviewViewProps = {
  page: InventoryPage<'consents'> | null;
  pending: boolean;
  reducing: boolean;
  error: string;
  selection: ConnectedApplicationSelection | null;
  preflight: boolean;
  operation?: ConsentOperationBoundary;
  reviewElement: Ref<HTMLFieldSetElement>;
  currentReview: boolean;
  onReviewCurrent: () => void;
  onNavigate: (target: string | undefined, direction: 'next' | 'previous') => void;
  onReloadCurrent: () => void;
  onRetryPage: () => void;
  onFirstPage: () => void;
  onSelect: (consent: GrantedConsent, removeAll: boolean) => void;
  onRemovePermission: (scope: string) => void;
  onConfirmReview: () => void;
  onReduce: () => void;
  onCancel: () => void;
  canNavigatePrevious: boolean;
  previousCursor?: string | undefined;
  canReloadCurrent: boolean;
  canNavigateFirstPage: boolean;
  canRetryPage: boolean;
  focusAcceptedPage: number;
  focusFailedPage: number;
  focusReturnClientId: string;
  onFocusReturned: () => void;
};

function errorFor(result: ConsentReductionResult): string {
  if (result.kind === 'pending') return m.auth_inventory_consent_pending();
  if (result.kind === 'signed-out') return m.auth_account_operation_sign_in_required();
  if (result.kind === 'denied' || result.kind === 'stale-review') return m.auth_inventory_denied();
  return m.auth_inventory_unavailable();
}

export function useConnectedApplicationReview({
  source = loadInventory,
  preflight = false,
  operation,
  onSessionEnded,
  lifetime,
}: ConnectedApplicationReviewOptions): ConnectedApplicationReviewViewProps {
  const [page, setPage] = useState<InventoryPage<'consents'> | null>(null);
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [acceptedCursor, setAcceptedCursor] = useState<string | undefined>(undefined);
  const [hasAcceptedPage, setHasAcceptedPage] = useState(false);
  const [failedTransition, setFailedTransition] = useState<NavigationTransition | null>(null);
  const [pending, setPending] = useState(true);
  const [reducing, setReducing] = useState(false);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<ConnectedApplicationSelection | null>(null);
  const [focusReturnClientId, setFocusReturnClientId] = useState('');
  const [focusAcceptedPage, setFocusAcceptedPage] = useState(0);
  const [focusFailedPage, setFocusFailedPage] = useState(0);
  const phase = useRef<ReviewPhase>('idle');
  const generation = useRef(0);
  const pendingRef = useRef(false);
  const requestedRead = useRef<NavigationTransition | null>(null);
  const reviewOperation = useRef<ConsentReviewOperation | null>(null);
  const reviewElement = useRef<HTMLFieldSetElement>(null);
  const acceptedCursorRef = useRef<string | undefined>(undefined);
  const historyRef = useRef<(string | undefined)[]>([]);
  const [observation, setObservation] = useState(() => ({ source, lifetime }));
  const observationRetired = observation.source !== source || observation.lifetime !== lifetime || lifetime?.aborted === true;
  const onSessionEndedRef = useRef(onSessionEnded);
  onSessionEndedRef.current = onSessionEnded;

  useLayoutEffect(() => {
    function clearReadState(retireLifetime: boolean) {
      generation.current++;
      pendingRef.current = false;
      requestedRead.current = null;
      acceptedCursorRef.current = undefined;
      historyRef.current = [];
      if (retireLifetime) {
        reviewOperation.current = null;
        phase.current = 'idle';
      } else if (phase.current === 'review') {
        phase.current = 'idle';
        const held = reviewOperation.current;
        reviewOperation.current = null;
        held?.finish();
      }
      setPage(null);
      setHistory([]);
      setAcceptedCursor(undefined);
      setHasAcceptedPage(false);
      setFailedTransition(null);
      setPending(false);
      setReducing(false);
      setError('');
      setSelection(null);
      setFocusReturnClientId('');
      setFocusAcceptedPage(0);
      setFocusFailedPage(0);
    }

    function retire() {
      clearReadState(true);
    }

    lifetime?.addEventListener('abort', retire, { once: true });
    clearReadState(false);
    setObservation({ source, lifetime });
    if (!lifetime?.aborted) void navigate(undefined, 'first');
    return () => {
      lifetime?.removeEventListener('abort', retire);
      generation.current++;
      pendingRef.current = false;
      requestedRead.current = null;
      acceptedCursorRef.current = undefined;
      historyRef.current = [];
      if (phase.current === 'review') {
        phase.current = 'idle';
        const held = reviewOperation.current;
        reviewOperation.current = null;
        held?.finish();
      }
    };
  }, [source, lifetime]);

  useLayoutEffect(() => {
    if (observationRetired || pendingRef.current || !page || page.kind !== 'ready' || !selection) return;
    const target = selection.confirming ? reviewElement.current : reviewElement.current?.querySelector('button');
    target?.focus();
  }, [observationRetired, page, selection]);

  async function navigate(target?: string, direction: NavigationDirection = 'first') {
    if (lifetime?.aborted || pendingRef.current || phase.current === 'review' || phase.current === 'submitting') return;
    const transition: NavigationTransition = { ...(target === undefined ? {} : { target }), direction };
    pendingRef.current = true;
    requestedRead.current = transition;
    const current = ++generation.current;
    setPending(true);
    setPage(null);
    setError('');
    setSelection(null);
    setFailedTransition(null);
    const result = await source('consents', target);
    if (generation.current !== current || requestedRead.current !== transition || lifetime?.aborted) return;
    pendingRef.current = false;
    requestedRead.current = null;
    setPending(false);
    setPage(result);
    if (result.kind === 'ready') {
      let nextHistory = historyRef.current;
      if (direction === 'next') nextHistory = [...nextHistory, acceptedCursorRef.current].slice(-MAX_CURSOR_HISTORY);
      else if (direction === 'previous') nextHistory = nextHistory.slice(0, -1);
      else if (direction === 'first') nextHistory = [];
      historyRef.current = nextHistory;
      setHistory(nextHistory);
      acceptedCursorRef.current = target;
      setAcceptedCursor(target);
      setHasAcceptedPage(true);
      setFocusAcceptedPage((count) => count + 1);
    } else {
      setFailedTransition(transition);
      setFocusFailedPage((count) => count + 1);
      if (result.kind === 'signed-out') onSessionEndedRef.current?.();
    }
  }

  function select(consent: GrantedConsent, removeAll: boolean) {
    if (lifetime?.aborted || preflight || pendingRef.current || phase.current !== 'idle') return;
    const held = operation?.begin();
    if (operation && !held) return;
    reviewOperation.current = held ?? null;
    phase.current = 'review';
    setFocusReturnClientId('');
    setError('');
    // The local draft is retired with this page and never enters route history.
    const snapshot: GrantedConsent = {
      client_id: consent.client_id,
      display_name: consent.display_name,
      granted: [...consent.granted],
      status: consent.status,
      reducible: consent.reducible,
      pending_reduction: consent.pending_reduction,
    };
    setSelection({ consent: snapshot, retained: removeAll ? [] : [...snapshot.granted], confirming: removeAll });
  }

  function finishReview() {
    phase.current = 'idle';
    setReducing(false);
    setSelection(null);
    const held = reviewOperation.current;
    reviewOperation.current = null;
    held?.finish();
  }

  function cancelReview() {
    if (phase.current !== 'review' || !selection) return;
    setFocusReturnClientId(selection.consent.client_id);
    finishReview();
    setError('');
  }

  async function reduce() {
    if (lifetime?.aborted || !selection?.confirming || preflight || pendingRef.current || phase.current !== 'review')
      return;
    const held = reviewOperation.current;
    if (held && !held.isCurrent()) return;
    const { consent, retained } = selection;
    const target = createConsentReduction(consent, retained);
    if (!target) return;

    phase.current = 'submitting';
    setReducing(true);
    setError('');
    const current = generation.current;
    const fresh = await source('consents', acceptedCursorRef.current);
    if (generation.current !== current || lifetime?.aborted || (held && !held.isCurrent())) return;

    if (fresh.kind === 'expired') {
      finishReview();
      setPage(fresh);
      setError(m.auth_inventory_expired());
      return;
    }
    if (fresh.kind !== 'ready') {
      finishReview();
      setPage(fresh);
      setError('');
      if (fresh.kind === 'signed-out') onSessionEndedRef.current?.();
      return;
    }

    const row = fresh.rows.find((entry) => entry.client_id === target.clientId);
    const matches =
      row &&
      row.granted.length === target.current.length &&
      row.granted.every((scope) => target.current.includes(scope)) &&
      createConsentReduction(row, target.retained);
    let result: ConsentReductionResult;
    if (row?.pending_reduction) result = { kind: 'pending' };
    else if (!matches) result = { kind: 'denied' };
    else result = await reduceConsent(consent, target.retained, held ?? undefined);

    if (generation.current !== current || lifetime?.aborted || (held && !held.isCurrent())) return;
    if (result.kind === 'retired') return;

    if (result.kind === 'stale-review') {
      pendingRef.current = true;
      setPending(true);
      const updated = await source('consents', acceptedCursorRef.current);
      if (generation.current !== current || lifetime?.aborted || (held && !held.isCurrent())) return;
      pendingRef.current = false;
      setPending(false);
      finishReview();
      setError(m.auth_consent_stale_review());
      setPage(updated);
      setFocusReturnClientId(consent.client_id);
      if (updated.kind === 'signed-out') onSessionEndedRef.current?.();
      return;
    }

    if (result.kind === 'unknown') {
      // The request was sent, but only a later explicit read can review current
      // permissions. It cannot replay or settle this operation.
      phase.current = 'unknown';
      setSelection(null);
      setReducing(false);
      setError(m.auth_inventory_unknown());
      setPage(null);
      acceptedCursorRef.current = undefined;
      setAcceptedCursor(undefined);
      setHasAcceptedPage(false);
      historyRef.current = [];
      setHistory([]);
      setFailedTransition(null);
      return;
    }

    finishReview();
    if (result.kind === 'accepted') {
      setPage(null);
      setError('');
      onSessionEndedRef.current?.();
      return;
    }

    setError(errorFor(result));
    if (result.kind === 'signed-out') {
      setPage({ kind: 'signed-out' });
      onSessionEndedRef.current?.();
    } else if (result.kind === 'denied' || result.kind === 'pending') {
      setPage(fresh);
      setFocusReturnClientId(consent.client_id);
    } else {
      setPage({ kind: 'unavailable' });
    }
  }

  function removePermission(scope: string) {
    setSelection((draft) =>
      draft && !draft.confirming ? { ...draft, retained: draft.retained.filter((entry) => entry !== scope) } : draft,
    );
  }

  return {
    page: observationRetired ? null : page,
    pending: observationRetired || pending,
    reducing: observationRetired ? false : reducing,
    error: observationRetired ? '' : error,
    selection: observationRetired ? null : selection,
    preflight,
    ...(operation ? { operation } : {}),
    reviewElement,
    currentReview: !observationRetired && phase.current === 'unknown',
    onReviewCurrent: () => void navigate(),
    onNavigate: (target, direction) => void navigate(target, direction),
    onReloadCurrent: () => void navigate(acceptedCursorRef.current, 'reload'),
    onRetryPage: () => {
      if (failedTransition) void navigate(failedTransition.target, failedTransition.direction);
    },
    onFirstPage: () => void navigate(undefined, 'first'),
    onSelect: select,
    onRemovePermission: removePermission,
    onConfirmReview: () => setSelection((draft) => (draft ? { ...draft, confirming: true } : null)),
    onReduce: () => void reduce(),
    onCancel: cancelReview,
    canNavigatePrevious: !observationRetired && history.length > 0,
    previousCursor: observationRetired ? undefined : history.at(-1),
    canReloadCurrent: !observationRetired && hasAcceptedPage,
    canNavigateFirstPage: !observationRetired && (acceptedCursor !== undefined || failedTransition !== null),
    canRetryPage: !observationRetired && failedTransition !== null,
    focusAcceptedPage: observationRetired ? 0 : focusAcceptedPage,
    focusFailedPage: observationRetired ? 0 : focusFailedPage,
    focusReturnClientId: observationRetired ? '' : focusReturnClientId,
    onFocusReturned: () => setFocusReturnClientId(''),
  };
}
