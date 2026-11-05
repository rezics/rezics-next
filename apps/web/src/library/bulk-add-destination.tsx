import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { CollectionMoveChooser } from './collection-move-chooser';
import type { CollectionDestination } from './collection-read';
import { captureBulkAddDestination, type BulkAddCapture, type BulkAddSelection } from './bulk-add-selection';

/** Destination capture only; the receiving native preview is supplied by the enclosing journey. */
export function BulkAddDestination({
  selection,
  current,
  disabled = false,
  onCapture,
}: {
  selection: BulkAddSelection;
  /** Must retain the originating viewer, exposure and locale episode. */
  current: () => boolean;
  disabled?: boolean;
  onCapture: (capture: BulkAddCapture) => void;
}) {
  const [destination, setDestination] = useState<CollectionDestination | null>(null);
  const [captured, setCaptured] = useState<BulkAddCapture | null>(null);
  const submitted = useRef(false);
  const selectionKey = JSON.stringify(selection.subjects);
  const selectionKeyRef = useRef(selectionKey);
  const [selectionEpoch, setSelectionEpoch] = useState(0);
  useLayoutEffect(() => {
    if (selectionKeyRef.current === selectionKey) return;
    selectionKeyRef.current = selectionKey;
    if (!submitted.current) {
      setDestination(null);
      setCaptured(null);
      setSelectionEpoch((epoch) => epoch + 1);
    }
  }, [selectionKey]);
  const chooserCurrent = () => current() && !submitted.current && selectionKeyRef.current === selectionKey;
  function capture(event: FormEvent) {
    event.preventDefault();
    if (disabled || !chooserCurrent() || !destination) return;
    const value = captureBulkAddDestination(selection, destination);
    submitted.current = true;
    setCaptured(value);
    onCapture(value);
  }
  if (!current()) return null;
  return (
    <form onSubmit={capture} aria-label={m.library_bulk_add_destination()} className="space-y-3 rounded-xl border p-3">
      <h2 className="font-semibold">{m.library_bulk_add_destination()}</h2>
      <p>{m.library_bulk_add_loaded({ count: captured?.subjects.length ?? selection.subjects.length })}</p>
      <CollectionMoveChooser
        key={selectionEpoch}
        sourceId=""
        placement={false}
        disabled={disabled || submitted.current}
        current={chooserCurrent}
        onChange={(choice) => {
          if (chooserCurrent()) setDestination(choice?.destination ?? null);
        }}
      />
      {captured ? <p>{m.library_bulk_add_captured_destination({ title: captured.destination.title })}</p> : null}
      <Button type="submit" disabled={disabled || submitted.current || !destination}>
        {m.library_bulk_add_review()}
      </Button>
    </form>
  );
}
