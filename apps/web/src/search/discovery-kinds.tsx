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
  const [pages, setPages] = useState([initial]);
  const [status, setStatus] = useState<DiscoveryKindsState['status']>();
  const [recovery, setRecovery] = useState<SearchRecoveryState>();
  const waiting = useSearchRetryWait(recovery && recovery.status !== 'ready' ? recovery.retryAt : undefined);
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => pending.current?.abort(), []);
  const values = pages.flatMap((page) => page.values);
  const next = pages.at(-1)?.next;
  const continuations = useRef(new KindContinuationLedger());
  async function more() {
    if (!next || pending.current || waiting) return;
    const controller = new AbortController();
    pending.current = controller;
    setStatus('loading');
    setRecovery(undefined);
    try {
      const result = await load(next, controller.signal);
      if (controller.signal.aborted) return;
      setRecovery(result.recovery);
      if (result.status === 'ready') {
        const seen = new Set(values.map((kind) => kind.id));
        if (
          result.kinds.values.some((kind) => seen.has(kind.id)) ||
          continuations.current.repeats(next, result.kinds.next)
        )
          setStatus('unavailable');
        else {
          continuations.current.consume(next);
          setPages((pages) => [...pages, result.kinds]);
          setStatus(undefined);
        }
      } else setStatus(result.status);
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
      {selected.length === 0 && (
        <p role="status" className="text-sm">
          {m.search_all_kinds()}
        </p>
      )}
      {selected
        .filter((id) => !values.some((kind) => kind.id === id))
        .map((id) => (
          <input key={id} type="hidden" name="kinds" value={id} />
        ))}
      <details open={selected.length > 0}>
        <summary className="cursor-pointer text-sm font-medium">{m.search_choose_kinds()}</summary>
        <ul className="space-y-2 pt-3">
          {values.map((kind) => {
            const label = localizedLabel(kind.labels, locale);
            const count = kind.count;
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
                    defaultChecked={selected.includes(kind.id)}
                    className="mt-0.5 size-4 shrink-0 accent-primary"
                    onChange={(event) => {
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
      {next && (
        <Button type="button" variant="outline" disabled={!hydrated || status === 'loading' || waiting} onClick={more}>
          {m.discovery_more_kinds()}
        </Button>
      )}
    </section>
  );
}
