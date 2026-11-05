import type { CompositionRulesIdentity } from './composition-destination';
import { sameCompositionRulesIdentity } from './composition-destination';
import { m } from '../paraglide/messages.js';
import type { RefObject } from 'react';

export function CompositionRulesVersionNotice({
  previous,
  current,
  triggerRef,
  onInspect,
}: {
  previous: CompositionRulesIdentity | null;
  current: CompositionRulesIdentity | undefined;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onInspect: () => void;
}) {
  if (
    !previous ||
    !current ||
    previous.destinationKey !== current.destinationKey ||
    sameCompositionRulesIdentity(previous, current)
  )
    return null;

  return (
    <div role="status" className="space-y-2 rounded-xl border border-border bg-muted/50 p-3">
      <p className="text-sm text-muted-foreground">{m.composition_destination_rules_changed()}</p>
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={onInspect}
      >
        {m.composition_destination_inspect_rules()}
      </button>
    </div>
  );
}
