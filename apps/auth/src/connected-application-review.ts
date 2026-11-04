import { useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react';
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
  onNavigate: (target?: string, direction?: 'next' | 'previous' | 'reset') => void;
  onSelect: (consent: GrantedConsent, removeAll: boolean) => void;
  onRemovePermission: (scope: string) => void;
  onConfirmReview: () => void;
  onReduce: () => void;
  onCancel: () => void;
  canNavigatePrevious: boolean;
  previousCursor?: string | undefined;
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
  const [pending, setPending] = useState(true);
  const [reducing, setReducing] = useState(false);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<ConnectedApplicationSelection | null>(null);
  const [focusReturnClientId, setFocusReturnClientId] = useState('');
  const phase = useRef<ReviewPhase>('idle');
  const generation = useRef(0);
  const pendingRef = useRef(false);
  const reviewOperation = useRef<ConsentReviewOperation | null>(null);
  const reviewElement = useRef<HTMLFieldSetElement>(null);
  const cursorRef = useRef<string | undefined>(undefined);
  const onSessionEndedRef = useRef(onSessionEnded);
  onSessionEndedRef.current = onSessionEnded;

  useLayoutEffect(() => {
    if (!selection) return;
    const target = selection.confirming ? reviewElement.current : reviewElement.current?.querySelector('button');
    target?.focus();
  }, [selection]);

  useLayoutEffect(() => {
    function retire() {
      generation.current++;
      pendingRef.current = false;
      cursorRef.current = undefined;
      reviewOperation.current = null;
      phase.current = 'idle';
      setPage(null);
      setHistory([]);
      setPending(false);
      setReducing(false);
      setError('');
      setSelection(null);
      setFocusReturnClientId('');
    }
    lifetime?.addEventListener('abort', retire, { once: true });
    return () => {
      lifetime?.removeEventListener('abort', retire);
      generation.current++;
      if (phase.current === 'review') reviewOperation.current?.finish();
    };
  }, [lifetime]);

  useEffect(() => {
    if (lifetime?.aborted) return;
    const current = ++generation.current;
    pendingRef.current = true;
    setPending(true);
    setPage(null);
    void source('consents')
      .catch((): InventoryPage<'consents'> => ({ kind: 'unavailable' }))
      .then((result) => {
        if (generation.current !== current || lifetime?.aborted) return;
        pendingRef.current = false;
        setPage(result);
        setPending(false);
        if (result.kind === 'signed-out') onSessionEndedRef.current?.();
      });
    return () => {
      generation.current++;
    };
  }, [source, lifetime]);

  async function navigate(target?: string, direction: 'next' | 'previous' | 'reset' = 'reset') {
    if (lifetime?.aborted || pendingRef.current || phase.current === 'review' || phase.current === 'submitting') return;
    pendingRef.current = true;
    const current = ++generation.current;
    setPending(true);
    setError('');
    const result = await source('consents', target).catch((): InventoryPage<'consents'> => ({ kind: 'unavailable' }));
    if (generation.current !== current || lifetime?.aborted) return;
    pendingRef.current = false;
    setPending(false);
    setPage(result);
    if (result.kind === 'ready') {
      setHistory((previous) =>
        direction === 'next' ? [...previous, cursorRef.current] : direction === 'previous' ? previous.slice(0, -1) : [],
      );
      cursorRef.current = target;
    } else if (result.kind === 'signed-out') onSessionEndedRef.current?.();
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
    const fresh = await source('consents', cursorRef.current).catch((): InventoryPage<'consents'> => ({
      kind: 'unavailable',
    }));
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
      const updated = await source('consents', cursorRef.current).catch((): InventoryPage<'consents'> => ({
        kind: 'unavailable',
      }));
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
      cursorRef.current = undefined;
      setHistory([]);
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
    page,
    pending,
    reducing,
    error,
    selection,
    preflight,
    ...(operation ? { operation } : {}),
    reviewElement,
    currentReview: phase.current === 'unknown',
    onReviewCurrent: () => void navigate(),
    onNavigate: (target, direction) => void navigate(target, direction),
    onSelect: select,
    onRemovePermission: removePermission,
    onConfirmReview: () => setSelection((draft) => (draft ? { ...draft, confirming: true } : null)),
    onReduce: () => void reduce(),
    onCancel: cancelReview,
    canNavigatePrevious: history.length > 0,
    previousCursor: history.at(-1),
    focusReturnClientId,
    onFocusReturned: () => setFocusReturnClientId(''),
  };
}
