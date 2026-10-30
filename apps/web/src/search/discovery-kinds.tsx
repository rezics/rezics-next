import { useEffect, useRef, useState } from 'react';
import { NativeCheckbox } from '@rezics/ui/native-checkbox';
import { Button } from '@rezics/ui/shadcn/button';
import { Label } from '@rezics/ui/shadcn/label';
import { m } from '../paraglide/messages.js';
import { localizedLabel } from './results';
import { discoveryMessage } from './discovery-results';
import type { DiscoveryKinds as Kinds, DiscoveryKindsState } from './discovery';

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
  load: (cursor: string, signal: AbortSignal) => Promise<DiscoveryKindsState>;
}) {
  const [pages, setPages] = useState([initial]);
  const [status, setStatus] = useState<DiscoveryKindsState['status']>();
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => pending.current?.abort(), []);
  const values = pages.flatMap((page) => page.values);
  const next = pages.at(-1)?.next;
  const consumed = useRef(new Set<string>());
  async function more() {
    if (!next || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setStatus('loading');
    try {
      const result = await load(next, controller.signal);
      if (controller.signal.aborted) return;
      if (result.status === 'ready') {
        const seen = new Set(values.map((kind) => kind.id));
        if (
          result.kinds.values.some((kind) => seen.has(kind.id)) ||
          (result.kinds.next && consumed.current.has(result.kinds.next))
        )
          setStatus('unavailable');
        else {
          consumed.current.add(next);
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
    <section className="space-y-3" aria-label={m.search_types()}>
      <h2 className="font-medium">{m.search_types()}</h2>
      {selected
        .filter((id) => !values.some((kind) => kind.id === id))
        .map((id) => (
          <input key={id} type="hidden" name="kinds" value={id} />
        ))}
      <ul className="space-y-2">
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
      {status && (
        <p role={status === 'loading' ? 'status' : 'alert'} className="text-sm text-muted-foreground">
          {discoveryMessage(status)}
        </p>
      )}
      {next && (
        <Button type="button" variant="outline" disabled={!hydrated || status === 'loading'} onClick={more}>
          {m.discovery_more_kinds()}
        </Button>
      )}
    </section>
  );
}
