import { useEffect, useRef, useState } from 'react';
import { NativeCheckbox } from '@rezics/ui/native-checkbox';
import { Button } from '@rezics/ui/shadcn/button';
import { Label } from '@rezics/ui/shadcn/label';
import { m } from '../paraglide/messages.js';
import { localizedLabel } from './results';
import { discoveryMessage } from './discovery-results';
import type { DiscoveryKinds as Kinds, DiscoveryKindsState } from './discovery';
import { KindContinuationLedger } from './kind-continuation';
import type { SearchRecoveryState } from './search-recovery';
import { searchRecoveryMessage } from './search-recovery-view';
import { useSearchRetryWait } from './search-recovery-retry';

/** Registry pages are explicit bounded reads; rows and initial count evidence remain in place. */
export function DiscoveryKinds({
  initial,
  selected,
  locale,
  hydrated,
  load,
}: {
  initial: Kinds;
  selected: string[];
  locale: string;
  hydrated: boolean;
  load: (cursor: string, signal: AbortSignal) => Promise<DiscoveryKindsState & { recovery?: SearchRecoveryState }>;
}) {
  const [continuation, setContinuation] = useState<Kinds>();
  const [chosen, setChosen] = useState(() => new Set(selected));
  const [stopped, setStopped] = useState(false);
  const [refused, setRefused] = useState(false);
  const [continuations] = useState(() => new KindContinuationLedger(initial.values.map((kind) => kind.id)));
  const [status, setStatus] = useState<DiscoveryKindsState['status']>();
  const [recovery, setRecovery] = useState<SearchRecoveryState>();
  const waiting = useSearchRetryWait(recovery && recovery.status !== 'ready' ? recovery.retryAt : undefined);
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => pending.current?.abort(), []);
  const values = refused ? [] : [...initial.values, ...(continuation?.values ?? [])];
  const next = continuation ? continuation.next : initial.next;
  const restartable = !refused && (stopped || continuations.limited || next === null);
  function restart() {
    continuations.restart();
    setContinuation(undefined);
    setStopped(false);
    setStatus(undefined);
    setRecovery(undefined);
  }
  async function more() {
    if (!next || pending.current || waiting || stopped || continuations.limited || refused) return;
    const controller = new AbortController();
    pending.current = controller;
    setStatus('loading');
    setRecovery(undefined);
    try {
      const result = await load(next, controller.signal);
      if (controller.signal.aborted) return;
      setRecovery(result.recovery);
      if (result.status === 'ready') {
        if (
          !continuations.accept(
            next,
            result.kinds.values.map((kind) => kind.id),
            result.kinds.next,
          )
        ) {
          setStopped(true);
          setStatus(undefined);
        } else {
          setContinuation(result.kinds);
          setStatus(undefined);
        }
      } else {
        // Only transport outages retain an accepted directory for an exact-cursor retry.
        const retryable =
          result.status === 'unavailable' && (!result.recovery || result.recovery.status === 'unavailable');
        setRefused(!retryable);
        if (!retryable) setContinuation(undefined);
        setStatus(result.status);
      }
    } catch (error) {
      if (!controller.signal.aborted) setStatus('unavailable');
    } finally {
      if (pending.current === controller) pending.current = undefined;
    }
  }
  return (
    <section className="space-y-3" aria-label={m.search_result_kinds()}>
      <h2 className="font-medium">{m.search_result_kinds()}</h2>
      <p className="text-sm text-muted-foreground">{m.search_result_kinds_help()}</p>
      {chosen.size === 0 && (
        <p role="status" className="text-sm">
          {m.search_all_kinds()}
        </p>
      )}
      {[...chosen]
        .filter((id) => !values.some((kind) => kind.id === id))
        .map((id) => (
          <input key={id} type="hidden" name="kinds" value={id} />
        ))}
      <details open={chosen.size > 0}>
        <summary className="cursor-pointer text-sm font-medium">{m.search_choose_kinds()}</summary>
        <ul className="space-y-2 pt-3">
          {values.map((kind) => {
            const label = localizedLabel(kind.labels, locale);
            const count = initial.values.find((value) => value.id === kind.id)?.count;
            const evidence =
              count && 'value' in count
                ? `${new Intl.NumberFormat(locale).format(count.value)}${count.exact ? '' : '+'}`
                : m.discovery_count_unavailable();
            return (
              <li key={kind.id}>
                <Label className="items-start gap-2 text-sm font-normal">
                  <NativeCheckbox
                    aria-label={m.search_kind_choice({ value: label.text || kind.id })}
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
        <p role={status === 'loading' ? 'status' : 'alert'} className="text-sm text-muted-foreground">
          {recovery ? searchRecoveryMessage(recovery) : discoveryMessage(status)}
        </p>
      )}
      {waiting && <p className="text-sm text-muted-foreground">{m.search_recovery_wait()}</p>}
      {restartable && (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {stopped
              ? m.result_kind_window_progress()
              : continuations.limited
                ? m.result_kind_window_limit()
                : m.result_kind_window_end()}
          </p>
          <Button type="button" variant="outline" disabled={!hydrated || status === 'loading'} onClick={restart}>
            {m.result_kind_window_restart()}
          </Button>
        </>
      )}
      {next && !restartable && !refused && (
        <Button type="button" variant="outline" disabled={!hydrated || status === 'loading' || waiting} onClick={more}>
          {m.discovery_more_kinds()}
        </Button>
      )}
    </section>
  );
}
