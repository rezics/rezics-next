import { Menu, type MenuEntry } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { EllipsisIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { useOperation } from '../kernel/exposure';
import { useSession } from '../session/query';
import { csrfHeaders } from '../threads/composer';
import { pinCollection, unpinCollection } from './pins-actions';
import type { LibraryPinsRead } from './pins-read';

export type PinControlMode = 'collection' | 'list' | 'navigation';

/** One responsive menu for a Collection's pin action and list ordering controls. */
type PinControlInput = {
  collectionId: string;
  pins: LibraryPinsRead;
  mode: PinControlMode;
};

type PinAction = 'pin' | 'unpin' | 'up' | 'down';
type PinAttempt = {
  lifetime: symbol;
  action: PinAction;
  data: { collectionId: string; revision: number; after?: string | null; idempotencyKey: string };
  pending: boolean;
};

function pinLifetime(key: string) {
  return { key, lifetime: Symbol(), pending: false, notice: '', action: null as PinAction | null };
}

export function usePinControlActions({ collectionId, pins, mode }: PinControlInput): {
  canUpdate: boolean;
  entries: MenuEntry[];
  notice: string;
  pending: boolean;
} {
  const canPut = useOperation('library_pin.put') && pins.state === 'loaded' && pins.canUpdate === true;
  const canRemove = useOperation('library_pin.delete') && pins.state === 'loaded' && pins.canRemove === true;
  const loadedPins = pins.state === 'loaded' ? pins : null;
  const { state: session, subject, csrfToken } = useSession();
  const viewer = session === 'signed-in' && subject ? subject : null;
  const hasCsrf = Boolean(csrfToken);
  const router = useRouter();
  const queryClient = useQueryClient();
  const key = JSON.stringify([viewer, collectionId, canPut, canRemove, hasCsrf]);
  const [control, setControl] = useState(() => pinLifetime(key));
  const committed = useRef<symbol | null>(null);
  const attempt = useRef<PinAttempt | null>(null);
  const { lifetime, pending, notice, action: retainedAction } = control;

  // A refresh or nonempty token rotation keeps the attempt; authority loss creates a fresh lifetime.
  if (control.key !== key) setControl(pinLifetime(key));
  useLayoutEffect(() => {
    committed.current = lifetime;
    return () => {
      committed.current = null;
      attempt.current = null;
    };
  }, [lifetime]);
  const isCurrent = () => committed.current === lifetime;
  const update = (change: Partial<typeof control>) =>
    setControl((current) => (current.lifetime === lifetime ? { ...current, ...change } : current));

  const index = pins.state === 'loaded' ? pins.pins.findIndex((pin) => pin.collectionId === collectionId) : -1;
  const pinned = index >= 0;
  const orderedIds = loadedPins?.pins.map((pin) => pin.collectionId) ?? [];
  const pinCount = loadedPins?.pins.length ?? 0;
  const perform = async (action: PinAction) => {
    if (!isCurrent() || !viewer || !hasCsrf || !loadedPins || (action === 'unpin' ? !canRemove : !canPut)) return;
    let current = attempt.current;
    if (current) {
      if (current.lifetime !== lifetime || current.pending || current.action !== action) return;
    } else {
      if ((action === 'up' && index <= 0) || (action === 'down' && (index < 0 || index >= pinCount - 1))) return;
      const after = action === 'up' ? (index <= 1 ? null : orderedIds[index - 2]!) : orderedIds[index + 1]!;
      current = {
        lifetime,
        action,
        data: {
          collectionId,
          revision: loadedPins.revision,
          ...(action === 'up' || action === 'down' ? { after } : {}),
          idempotencyKey: crypto.randomUUID(),
        },
        pending: false,
      };
      attempt.current = current;
    }
    const captured = current;
    const isCurrentAttempt = () => isCurrent() && attempt.current === captured;
    // This synchronous lock also covers two selections before React commits the pending render.
    captured.pending = true;
    update({ pending: true, notice: '', action: captured.action });
    let retain = true;
    const refresh = () => {
      if (!isCurrentAttempt()) return [];
      const navigation = router.invalidate();
      const cache = isCurrentAttempt()
        ? queryClient.invalidateQueries({ queryKey: ['library-navigation'] })
        : undefined;
      return [navigation, cache];
    };
    try {
      const result =
        captured.action === 'unpin'
          ? await unpinCollection({ data: captured.data, headers: csrfHeaders() })
          : await pinCollection({ data: captured.data, headers: csrfHeaders() });
      if (!isCurrentAttempt()) return;
      retain = !result.ok && result.reason === 'unavailable';
      if (result.ok) {
        await Promise.all(refresh());
      } else if (result.reason === 'conflict') {
        update({ notice: m.library_pin_conflict() });
        await Promise.allSettled(refresh());
      } else if (result.reason === 'full') update({ notice: m.library_pin_limit() });
      else update({ notice: m.error_message() });
    } catch {
      if (isCurrentAttempt()) update({ notice: m.error_message() });
    } finally {
      if (isCurrentAttempt()) {
        captured.pending = false;
        if (!retain) attempt.current = null;
        update({ pending: false, action: retain ? captured.action : null });
      }
    }
  };

  const actions: PinAction[] = [];
  if (viewer && loadedPins) {
    if (pinned) {
      if (canPut && mode === 'list' && index > 0) actions.push('up');
      if (canPut && mode === 'list' && index < pinCount - 1) actions.push('down');
      if (canRemove) actions.push('unpin');
    } else if (canPut) actions.push('pin');
    // Keep an uncertain command explicitly retryable even if a refresh changes its menu placement.
    if (retainedAction && !actions.includes(retainedAction)) actions.push(retainedAction);
  }
  const labels = {
    pin: m.library_pin_pin(),
    unpin: m.library_pin_unpin(),
    up: m.library_pin_move_up(),
    down: m.library_pin_move_down(),
  };
  const entries: MenuEntry[] = actions.flatMap((action, index) => [
    ...(action === 'unpin' && index > 0 ? [{ type: 'separator' as const }] : []),
    {
      type: action === 'unpin' ? ('destructive' as const) : ('item' as const),
      label: labels[action],
      onSelect: () => void perform(action),
      disabled: pending || !hasCsrf || (retainedAction !== null && retainedAction !== action),
    },
  ]);

  return {
    canUpdate: entries.length > 0,
    entries,
    notice,
    pending,
  };
}

export function PinControlNotice({ notice }: { notice: string }) {
  return notice ? (
    <span className="max-w-48 text-right text-xs text-muted-foreground" role="status">
      {notice}
    </span>
  ) : null;
}

export function PinControl({ collectionId, pins, mode }: PinControlInput) {
  const control = usePinControlActions({ collectionId, pins, mode });
  if (!control.canUpdate) return null;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Menu
        title={m.library_pin_actions()}
        trigger={
          <Button aria-label={m.library_pin_actions()} disabled={control.pending} size="icon-sm" variant="ghost">
            <EllipsisIcon aria-hidden="true" />
          </Button>
        }
        entries={control.entries}
      />
      <PinControlNotice notice={control.notice} />
    </span>
  );
}
