import { useCallback, useEffect, useRef, useState } from 'react';
import { loadAccountSession } from './account-operations';
import { accountOperationSessionMatches } from './account-operation-step-up';
import { loadManagementSession, managementProfileSessionMatches, managementSessionMatches } from './management-operations';
import { organizationDeleteSessionMatches } from './organization-delete-step-up';
import { loadRecoveryPage, type RecoveryPageResult } from './recovery-page';
import {
  markManagementOperationReturned,
  markRenameReviewReturned,
  selectManagementOperationStepUp,
} from './management-operation-step-up';
import { signInTarget } from './sign-in';
import {
  managementStepUpSelectionMatches,
  retainedSelectionMatches,
  selectStepUp,
  type RetainedSelection,
} from './step-up';

export type StepUpHistory = 'unsent' | 'unknown' | 'refused' | 'acknowledged';
export type StepUpAdviceState = RecoveryPageResult | { kind: 'loading' };
export type StepUpReturnState =
  | { kind: 'checking' }
  | { kind: 'unavailable' }
  | { kind: 'changed' }
  | { kind: 'account-changed' }
  | { kind: 'none' }
  | { kind: 'continue'; target: string };

const loading: StepUpAdviceState = { kind: 'loading' };
const checking: StepUpReturnState = { kind: 'checking' };

/** Keep the recovery advice read local to this page so pagehide can retire it immediately. */
export function useStepUpAdvice() {
  const [generation, setGeneration] = useState(0);
  const [bound, setBound] = useState<{ generation: number; result: RecoveryPageResult } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const retired = useRef(false);

  const retry = useCallback(() => {
    retired.current = false;
    setBound(null);
    setGeneration((value) => value + 1);
  }, []);
  const retire = useCallback(() => {
    retired.current = true;
    controller.current?.abort();
    controller.current = null;
    setBound(null);
  }, []);

  useEffect(() => {
    retired.current = false;
    const request = new AbortController();
    controller.current = request;
    void loadRecoveryPage('step-up', request.signal).then((result) => {
      if (!request.signal.aborted) setBound({ generation, result });
    });
    return () => {
      request.abort();
      if (controller.current === request) controller.current = null;
    };
  }, [generation]);

  useEffect(() => {
    const refresh = () => {
      if (!retired.current && document.visibilityState === 'visible') retry();
    };
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pagehide', retire);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('pagehide', retire);
    };
  }, [retire, retry]);

  return {
    state: bound?.generation === generation ? bound.result : loading,
    retry,
    retire,
  };
}

function targetForRetained(origin: string, selection: RetainedSelection): string {
  return new URL(selection.pending.returnTo, origin).href;
}

/** Review reuses the exact selectors and bounded native session readers used by authentication returns. */
export async function inspectStepUpReturn(
  query: string,
  origin: string,
  advice: RecoveryPageResult,
  signal: AbortSignal,
  isCurrent: () => boolean,
  prepareForContinue = false,
): Promise<StepUpReturnState | null> {
  if (!isCurrent() || signal.aborted) return null;
  if (
    advice.kind !== 'ready' ||
    advice.page.stage !== 'step-up' ||
    !advice.page.actions.authenticate
  )
    return advice.kind === 'unavailable' ? { kind: 'unavailable' } : { kind: 'none' };

  const management = selectManagementOperationStepUp(query);
  if (management.kind === 'invalid') return { kind: 'changed' };
  if (management.kind === 'management' || management.kind === 'review') {
    const session = await loadManagementSession(signal);
    if (signal.aborted || !isCurrent()) return null;
    if (!managementStepUpSelectionMatches(query, management)) return { kind: 'changed' };
    if (session.kind === 'unavailable') return { kind: 'unavailable' };
    if (session.kind !== 'ready') return { kind: 'account-changed' };
    const matches =
      management.kind === 'review'
        ? managementProfileSessionMatches(session, 'rename', management.pending.accountId)
        : managementSessionMatches(session, management.pending);
    if (!matches) return { kind: 'account-changed' };
    if (
      prepareForContinue &&
      !(management.kind === 'review'
        ? markRenameReviewReturned(management.pending)
        : markManagementOperationReturned(management.pending))
    )
      return { kind: 'changed' };
    return { kind: 'continue', target: new URL(management.pending.returnTo, origin).href };
  }

  const selection = selectStepUp(query);
  if (selection.kind === 'invalid') return { kind: 'changed' };
  if (selection.kind === 'operation' || selection.kind === 'organization-delete') {
    const retained = selection as RetainedSelection;
    const session = await loadAccountSession(signal);
    if (signal.aborted || !isCurrent()) return null;
    if (!retainedSelectionMatches(query, retained)) return { kind: 'changed' };
    if (session.kind === 'failure') return { kind: 'unavailable' };
    if (session.kind !== 'ready') return { kind: 'account-changed' };
    const matches =
      retained.kind === 'organization-delete'
        ? organizationDeleteSessionMatches(session, retained.pending)
        : accountOperationSessionMatches(session, retained.pending);
    return matches ? { kind: 'continue', target: targetForRetained(origin, retained) } : { kind: 'account-changed' };
  }

  return advice.page.viewer.kind === 'signed-in'
    ? { kind: 'continue', target: signInTarget(query, origin) }
    : { kind: 'none' };
}

export async function recheckStepUpReturn(
  query: string,
  origin: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
  prepareForContinue = false,
): Promise<StepUpReturnState | null> {
  if (!isCurrent() || signal.aborted) return null;
  const advice = await loadRecoveryPage('step-up', signal);
  if (signal.aborted || !isCurrent()) return null;
  return inspectStepUpReturn(query, origin, advice, signal, isCurrent, prepareForContinue);
}

export function useStepUpReturnReview(
  query: string,
  origin: string,
  enabled: boolean,
  advice: StepUpAdviceState,
  isCurrent: () => boolean,
) {
  const [bound, setBound] = useState<{ advice: StepUpAdviceState; state: StepUpReturnState } | null>(null);
  const active = useRef<AbortController | null>(null);
  const state = bound?.advice === advice ? bound.state : checking;

  const retire = useCallback(() => {
    active.current?.abort();
    active.current = null;
  }, []);

  useEffect(() => {
    retire();
    if (!enabled) {
      setBound({ advice, state: checking });
      return;
    }
    if (advice.kind === 'loading') {
      setBound({ advice, state: checking });
      return;
    }
    if (advice.kind === 'unavailable') {
      setBound({ advice, state: { kind: 'unavailable' } });
      return;
    }
    const request = new AbortController();
    active.current = request;
    setBound({ advice, state: checking });
    void inspectStepUpReturn(query, origin, advice, request.signal, isCurrent).then((result) => {
      if (result && !request.signal.aborted) setBound({ advice, state: result });
    });
    return () => {
      request.abort();
      if (active.current === request) active.current = null;
    };
  }, [advice, enabled, isCurrent, origin, query, retire]);

  useEffect(() => {
    window.addEventListener('pagehide', retire);
    return () => window.removeEventListener('pagehide', retire);
  }, [retire]);

  const recheck = useCallback(async () => {
    retire();
    const request = new AbortController();
    active.current = request;
    setBound({ advice, state: checking });
    const result = await recheckStepUpReturn(query, origin, request.signal, isCurrent, true);
    if (result && !request.signal.aborted) setBound({ advice, state: result });
    if (active.current === request) active.current = null;
    return request.signal.aborted ? null : result;
  }, [advice, isCurrent, origin, query, retire]);

  return { state, recheck, retire };
}

