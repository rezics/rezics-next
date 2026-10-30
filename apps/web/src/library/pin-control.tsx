import { Menu, type MenuEntry } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { EllipsisIcon } from 'lucide-react';
import { useState } from 'react';
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

export function usePinControlActions({ collectionId, pins, mode }: PinControlInput): {
  canUpdate: boolean;
  entries: MenuEntry[];
  notice: string;
  pending: boolean;
} {
  const canUpdate = useOperation('library_pin.put') && pins.state === 'loaded' && pins.canUpdate !== false;
  const loadedPins = pins.state === 'loaded' ? pins : null;
  const { csrfToken } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');

  const index = pins.state === 'loaded' ? pins.pins.findIndex((pin) => pin.collectionId === collectionId) : -1;
  const pinned = index >= 0;
  const orderedIds = loadedPins?.pins.map((pin) => pin.collectionId) ?? [];
  const pinCount = loadedPins?.pins.length ?? 0;
  const perform = async (action: 'pin' | 'unpin' | 'up' | 'down') => {
    if (!csrfToken || pending || !loadedPins) return;
    setPending(true);
    setNotice('');
    const after =
      action === 'up'
        ? index <= 1
          ? null
          : orderedIds[index - 2]!
        : action === 'down'
          ? orderedIds[index + 1]!
          : undefined;
    try {
      const result =
        action === 'unpin'
          ? await unpinCollection({
              data: { collectionId, revision: loadedPins.revision, idempotencyKey: crypto.randomUUID() },
              headers: csrfHeaders(),
            })
          : await pinCollection({
              data: {
                collectionId,
                revision: loadedPins.revision,
                ...(action === 'up' || action === 'down' ? { after } : {}),
                idempotencyKey: crypto.randomUUID(),
              },
              headers: csrfHeaders(),
            });
      if (result.ok) {
        await Promise.all([router.invalidate(), queryClient.invalidateQueries({ queryKey: ['library-navigation'] })]);
      } else if (result.reason === 'conflict') {
        setNotice(m.library_pin_conflict());
        await Promise.allSettled([
          router.invalidate(),
          queryClient.invalidateQueries({ queryKey: ['library-navigation'] }),
        ]);
      } else if (result.reason === 'full') setNotice(m.library_pin_limit());
      else setNotice(m.error_message());
    } catch {
      setNotice(m.error_message());
    } finally {
      setPending(false);
    }
  };

  const moves: MenuEntry[] = [
    ...(mode === 'list' && index > 0
      ? [{ type: 'item' as const, label: m.library_pin_move_up(), onSelect: () => void perform('up') }]
      : []),
    ...(mode === 'list' && index < pinCount - 1
      ? [{ type: 'item' as const, label: m.library_pin_move_down(), onSelect: () => void perform('down') }]
      : []),
  ];
  const entries: MenuEntry[] =
    !canUpdate || pins.state !== 'loaded'
      ? []
      : pinned
        ? [
            ...moves,
            ...(moves.length ? [{ type: 'separator' as const }] : []),
            { type: 'destructive' as const, label: m.library_pin_unpin(), onSelect: () => void perform('unpin') },
          ]
        : [{ type: 'item' as const, label: m.library_pin_pin(), onSelect: () => void perform('pin') }];

  return {
    canUpdate: Boolean(canUpdate),
    entries: entries.map((entry) =>
      entry.type === 'separator' ? entry : { ...entry, disabled: pending || !csrfToken },
    ),
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
