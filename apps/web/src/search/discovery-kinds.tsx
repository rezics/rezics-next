import { useEffect, useLayoutEffect as useBrowserLayoutEffect, useRef, useState } from 'react';
import { NativeCheckbox } from '@rezics/ui/native-checkbox';
import { Button } from '@rezics/ui/shadcn/button';
import { Label } from '@rezics/ui/shadcn/label';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { localizedLabel } from './results';
import { discoveryMessage } from './discovery-results';
import type { DiscoveryKinds as Kinds, DiscoveryKindsState } from './discovery';
import { KindContinuationLedger } from './kind-continuation';
import type { SearchRecoveryState } from './search-recovery';
import { searchRecoveryMessage } from './search-recovery-view';
import { useSearchRetryWait } from './search-recovery-retry';

const useFocusLayoutEffect = typeof document === 'undefined' ? useEffect : useBrowserLayoutEffect;

function messageOptions(locale: string) {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

function sameOmittedKinds(left: Kinds['omitted'], right: Kinds['omitted']) {
  const signature = (value: Kinds['omitted']) =>
    JSON.stringify(
      (value ?? []).map(({ id, state }) => ({ id, state })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    );
  return signature(left) === signature(right);
}

function retryableRecovery(state: SearchRecoveryState | undefined) {
  return state === undefined || ['unavailable', 'index-not-ready', 'source-not-ready'].includes(state.status);
}

function refusalState(state: DiscoveryKindsState, recovery?: SearchRecoveryState): SearchRecoveryState {
  if (recovery) return recovery;
  switch (state.status) {
    case 'closed':
      return { status: 'closed' };
    case 'denied':
      return { status: 'denied' };
    case 'restart':
      return { status: 'restart' };
    case 'invalid':
    case 'unsupported':
      return { status: 'invalid' };
    default:
      return { status: 'unavailable' };
  }
}

/** Registry pages are explicit bounded reads; rows and initial count evidence remain in place. */
export function DiscoveryKinds({
  initial,
  checkpoint,
  selected,
  locale,
  hydrated,
  load,
  onRefresh,
  onRefreshFocus,
  onRefusalFocus,
  onRefusal,
}: {
  initial: Kinds;
  checkpoint: string;
  selected: string[];
  locale: string;
  hydrated: boolean;
  load: (cursor: string, signal: AbortSignal) => Promise<DiscoveryKindsState & { recovery?: SearchRecoveryState }>;
  /** Re-read the complete currently executed Search request through its existing reader owner. */
  onRefresh?: (() => void) | undefined;
  onRefreshFocus?: ((source: HTMLButtonElement) => void) | undefined;
  onRefusalFocus?: ((source: HTMLButtonElement) => void) | undefined;
  onRefusal?: ((state: SearchRecoveryState) => void) | undefined;
}) {
  const [continuation, setContinuation] = useState<Kinds>();
  const [chosen, setChosen] = useState(() => new Set(selected));
  const [stopped, setStopped] = useState(false);
  const [refused, setRefused] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [retryable, setRetryable] = useState(false);
  const [continuations] = useState(() => new KindContinuationLedger(initial.values.map((kind) => kind.id)));
  const [status, setStatus] = useState<DiscoveryKindsState['status']>();
  const [recovery, setRecovery] = useState<SearchRecoveryState>();
  const waiting = useSearchRetryWait(recovery && 'retryAt' in recovery ? recovery.retryAt : undefined);
  const pending = useRef<AbortController | undefined>(undefined);
  const moreButton = useRef<HTMLButtonElement>(null);
  const restartButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const recoveryRegion = useRef<HTMLElement>(null);
  const focusAction = useRef<
    | {
        source: HTMLButtonElement;
        document: Document;
        moved: boolean;
        complete: boolean;
        onFocusIn: (event: FocusEvent) => void;
      }
    | undefined
  >(undefined);
  function clearFocusAction(action: NonNullable<typeof focusAction.current>) {
    action.document.removeEventListener('focusin', action.onFocusIn, true);
    if (focusAction.current === action) focusAction.current = undefined;
  }
  function beginFocusAction(source: HTMLButtonElement) {
    const document = source.ownerDocument;
    if (document.activeElement !== source) return undefined;
    const action: NonNullable<typeof focusAction.current> = {
      source,
      document,
      moved: false,
      complete: false,
      onFocusIn: (event) => {
        if (event.target !== source) action.moved = true;
      },
    };
    document.addEventListener('focusin', action.onFocusIn, true);
    focusAction.current = action;
    return action;
  }
  useEffect(
    () => () => {
      pending.current?.abort();
      if (focusAction.current) clearFocusAction(focusAction.current);
    },
    [],
  );
  useFocusLayoutEffect(() => {
    const action = focusAction.current;
    if (!action?.complete) return;
    clearFocusAction(action);
    if (action.moved) return;
    const target = action.source.isConnected
      ? action.source
      : (moreButton.current ?? refreshButton.current ?? restartButton.current ?? recoveryRegion.current);
    if (target?.isConnected) target.focus();
  });
  const values = refused || needsRefresh ? [] : [...initial.values, ...(continuation?.values ?? [])];
  const next = continuation ? continuation.next : initial.next;
  const restartable = !refused && !needsRefresh && (stopped || continuations.limited || next === null);
  const canRetryCursor =
    !refused &&
    !needsRefresh &&
    !!next &&
    retryableRecovery(recovery) &&
    (status === 'preparing' || status === 'not-ready' || (status === 'unavailable' && retryable));

  function restart(source: HTMLButtonElement) {
    const action = beginFocusAction(source);
    continuations.restart();
    setContinuation(undefined);
    setStopped(false);
    setStatus(undefined);
    setRecovery(undefined);
    setRetryable(false);
    if (action) action.complete = true;
  }

  function refreshDirectory(source: HTMLButtonElement) {
    if (!onRefresh || waiting || refreshPending || pending.current || refused) return;
    onRefreshFocus?.(source);
    setRefreshPending(true);
    setStatus('loading');
    setRecovery(undefined);
    setRetryable(false);
    onRefresh();
  }

  async function more(source: HTMLButtonElement) {
    if (!next || pending.current || waiting || stopped || continuations.limited || refused || needsRefresh) return;
    const action = beginFocusAction(source);
    const controller = new AbortController();
    pending.current = controller;
    setStatus('loading');
    setRecovery(undefined);
    setRetryable(false);
    try {
      const result = await load(next, controller.signal);
      if (controller.signal.aborted) return;
      setRecovery(result.recovery);
      if (result.status === 'ready') {
        if (result.asOf !== checkpoint || !sameOmittedKinds(initial.omitted, result.kinds.omitted)) {
          setContinuation(undefined);
          setNeedsRefresh(true);
          setStatus('restart');
          setRecovery({ status: 'restart' });
        } else if (
          !continuations.accept(
            next,
            result.kinds.values.map((kind) => kind.id),
            result.kinds.next,
          )
        ) {
          setStopped(true);
          setStatus(undefined);
          setRecovery(undefined);
        } else {
          setContinuation(result.kinds);
          setStatus(undefined);
          setRecovery(undefined);
        }
      } else if (
        result.status === 'restart' ||
        result.recovery?.status === 'restart' ||
        result.recovery?.status === 'invalid-cursor'
      ) {
        setContinuation(undefined);
        setNeedsRefresh(true);
        setStatus(result.status);
      } else if (
        ['session', 'closed', 'denied', 'invalid'].includes(result.recovery?.status ?? '') ||
        result.status === 'closed' ||
        result.status === 'denied' ||
        result.status === 'invalid' ||
        result.status === 'unsupported' ||
        (result.status === 'unavailable' && result.retryable !== true) ||
        !retryableRecovery(result.recovery)
      ) {
        setContinuation(undefined);
        setRefused(true);
        setStatus(result.status);
        onRefusalFocus?.(source);
        onRefusal?.(refusalState(result, result.recovery));
      } else {
        setRetryable(result.status === 'unavailable' && result.retryable === true);
        setStatus(result.status);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!(error instanceof TypeError)) throw error;
      setRecovery({ status: 'unavailable' });
      setRetryable(true);
      setStatus('unavailable');
    } finally {
      if (pending.current === controller) pending.current = undefined;
      if (action) {
        if (controller.signal.aborted) clearFocusAction(action);
        else action.complete = true;
      }
    }
  }

  const options = messageOptions(locale);
  const directoryMessage = needsRefresh
    ? m.result_kind_refresh_required({}, options)
    : recovery && ['session', 'closed', 'denied'].includes(recovery.status)
      ? searchRecoveryMessage(recovery, locale)
      : status === 'preparing' || status === 'not-ready'
        ? m.result_kind_preparing({}, options)
        : status === 'unavailable' && (!recovery || recovery.status === 'unavailable')
          ? m.result_kind_unavailable({}, options)
          : recovery
            ? searchRecoveryMessage(recovery, locale)
            : status
              ? discoveryMessage(status, locale)
              : undefined;
  return (
    <section ref={recoveryRegion} className="space-y-3" aria-label={m.search_result_kinds({}, options)} tabIndex={-1}>
      <h2 className="font-medium">{m.search_result_kinds({}, options)}</h2>
      <p className="text-sm text-muted-foreground">{m.search_result_kinds_help({}, options)}</p>
      {chosen.size === 0 && (
        <p role="status" className="text-sm">
          {m.search_all_kinds({}, options)}
        </p>
      )}
      {[...chosen]
        .filter((id) => !values.some((kind) => kind.id === id))
        .map((id) => (
          <input key={id} type="hidden" name="kinds" value={id} />
        ))}
      <details open={chosen.size > 0}>
        <summary className="cursor-pointer text-sm font-medium">{m.search_choose_kinds({}, options)}</summary>
        <ul className="space-y-2 pt-3">
          {values.map((kind) => {
            const label = localizedLabel(kind.labels, locale);
            const count = initial.values.find((value) => value.id === kind.id)?.count;
            const evidence =
              count && 'value' in count
                ? `${new Intl.NumberFormat(locale).format(count.value)}${count.exact ? '' : '+'}`
                : m.discovery_count_unavailable({}, options);
            return (
              <li key={kind.id}>
                <Label className="items-start gap-2 text-sm font-normal">
                  <NativeCheckbox
                    aria-label={m.search_kind_choice({ value: label.text || kind.id }, options)}
                    name="kinds"
                    value={kind.id}
                    defaultChecked={chosen.has(kind.id)}
                    className="mt-0.5 size-4 shrink-0 accent-primary"
                    onChange={(event) => {
                      const { value, checked } = event.currentTarget;
                      setChosen((previous) => {
                        const updated = new Set(previous);
                        if (checked) updated.add(value);
                        else updated.delete(value);
                        return updated;
                      });
                      if (hydrated) event.currentTarget.form?.requestSubmit();
                    }}
                  />
                  <span lang={label.lang}>{label.text || kind.id}</span>
                  <span className="text-muted-foreground">{evidence}</span>
                </Label>
              </li>
            );
          })}
        </ul>
      </details>
      {status && (
        <p
          role={status === 'loading' || status === 'preparing' || status === 'not-ready' ? 'status' : 'alert'}
          className="text-sm text-muted-foreground"
        >
          {directoryMessage}
        </p>
      )}
      {waiting && <p className="text-sm text-muted-foreground">{m.search_recovery_wait({}, options)}</p>}
      {restartable && (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {stopped
              ? m.result_kind_window_progress({}, options)
              : continuations.limited
                ? m.result_kind_window_limit({}, options)
                : m.result_kind_window_end({}, options)}
          </p>
          <Button
            ref={restartButton}
            type="button"
            variant="outline"
            disabled={!hydrated || status === 'loading'}
            onClick={(event) => restart(event.currentTarget)}
          >
            {m.result_kind_window_restart({}, options)}
          </Button>
        </>
      )}
      {needsRefresh && onRefresh && (
        <Button
          ref={refreshButton}
          type="button"
          variant="outline"
          disabled={!hydrated || refreshPending || waiting}
          onClick={(event) => refreshDirectory(event.currentTarget)}
        >
          {m.result_kind_refresh({}, options)}
        </Button>
      )}
      {canRetryCursor && (
        <Button
          ref={moreButton}
          type="button"
          variant="outline"
          disabled={!hydrated || status === 'loading' || waiting}
          onClick={(event) => void more(event.currentTarget)}
        >
          {m.result_kind_retry({}, options)}
        </Button>
      )}
      {next && !restartable && !refused && !needsRefresh && !canRetryCursor && (
        <Button
          ref={moreButton}
          type="button"
          variant="outline"
          disabled={!hydrated || status === 'loading' || waiting}
          onClick={(event) => void more(event.currentTarget)}
        >
          {m.discovery_more_kinds({}, options)}
        </Button>
      )}
    </section>
  );
}
