import { useEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { readCollectionDestination, type CollectionDestination } from './collection-read';
import {
  readCollectionMoveChoices,
  readCollectionMovePlacements,
  type MoveChoices,
  type MovePlacements,
} from './collection-move-read';

export type CollectionMoveChoice = { destination: CollectionDestination; after: string | null };
const fieldClass = 'w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm';

export function CollectionMoveChooser({
  sourceId,
  disabled,
  current,
  onChange,
  placement = true,
}: {
  sourceId: string;
  disabled: boolean;
  current: () => boolean;
  onChange: (choice: CollectionMoveChoice | null) => void;
  /** Bulk add captures a destination only; its native executor determines placement. */
  placement?: boolean;
}) {
  const [choices, setChoices] = useState<MoveChoices>({ collections: [], next: null });
  const [placements, setPlacements] = useState<MovePlacements>({ members: [], next: null });
  const [destination, setDestination] = useState<CollectionDestination | null>(null);
  const [destinationId, setDestinationId] = useState('');
  const [after, setAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const version = useRef(0);
  const live = useRef(false);
  const callbacks = useRef({ current, onChange });
  callbacks.current = { current, onChange };
  const retained = (episode: number) => live.current && episode === version.current && callbacks.current.current();

  useEffect(() => {
    live.current = true;
    void readChoices();
    return () => {
      live.current = false;
      version.current++;
    };
  }, []);

  async function readChoices(next?: string) {
    if (!callbacks.current.current()) return;
    const episode = ++version.current;
    setLoading(true);
    setFailed(false);
    callbacks.current.onChange(null);
    try {
      const page = await readCollectionMoveChoices({ data: next });
      if (!retained(episode)) return;
      setChoices((previous) => ({
        collections: next ? [...previous.collections, ...page.collections] : page.collections,
        next: page.next,
      }));
      if (destination) callbacks.current.onChange({ destination, after });
    } catch {
      if (retained(episode)) setFailed(true);
    } finally {
      if (retained(episode)) setLoading(false);
    }
  }

  async function choose(id: string, next?: string) {
    if (!callbacks.current.current()) return;
    const episode = ++version.current;
    setLoading(true);
    setFailed(false);
    callbacks.current.onChange(null);
    if (!next) {
      setDestinationId(id);
      setDestination(null);
      setAfter(null);
      setPlacements({ members: [], next: null });
    }
    try {
      if (!id) return;
      const target = next ? destination : await readCollectionDestination({ data: id });
      if (!retained(episode)) return;
      if (!target || target.id !== id || target.id === sourceId) throw new Error('Move destination unavailable');
      if (!placement) {
        setDestination(target);
        callbacks.current.onChange({ destination: target, after: null });
        return;
      }
      const page = await readCollectionMovePlacements({
        data: { collectionId: id, revision: target.revision, cursor: next },
      });
      if (!retained(episode)) return;
      setDestination(target);
      setPlacements((previous) => ({
        members: next ? [...previous.members, ...page.members] : page.members,
        next: page.next,
      }));
      callbacks.current.onChange({ destination: target, after: next ? after : null });
    } catch {
      if (retained(episode)) setFailed(true);
    } finally {
      if (retained(episode)) setLoading(false);
    }
  }

  return (
    <div className="flex min-w-0 basis-full flex-wrap items-end gap-2" data-collection-move-chooser>
      <label className="min-w-0 flex-1 space-y-1">
        <span className="text-sm">{m.library_collection_move_destination()}</span>
        <select
          className={fieldClass}
          value={destinationId}
          disabled={disabled || loading}
          onChange={(event) => void choose(event.target.value)}
        >
          <option value="">{m.library_collection_choose_destination()}</option>
          {choices.collections
            .filter((choice) => choice.id !== sourceId)
            .map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.title}
              </option>
            ))}
        </select>
      </label>
      {choices.next ? (
        <Button
          type="button"
          variant="outline"
          disabled={disabled || loading}
          onClick={() => void readChoices(choices.next!)}
        >
          {m.library_collection_move_more_destinations()}
        </Button>
      ) : null}
      {destination && placement ? (
        <label className="min-w-0 basis-full space-y-1">
          <span className="text-sm">{m.library_collection_move_placement()}</span>
          <select
            className={fieldClass}
            value={after ?? ''}
            disabled={disabled || loading || failed}
            onChange={(event) => {
              if (!callbacks.current.current()) return;
              const anchor = event.target.value || null;
              setAfter(anchor);
              callbacks.current.onChange({ destination, after: anchor });
            }}
          >
            <option value="">{m.library_collection_move_first()}</option>
            {placements.members.map((member, index) => (
              <option key={member.id} value={member.id}>
                {m.library_collection_move_after({ position: index + 1, title: member.title })}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {destination && placement && placements.next ? (
        <Button
          type="button"
          variant="outline"
          disabled={disabled || loading || failed}
          onClick={() => void choose(destination.id, placements.next!)}
        >
          {m.library_collection_move_more_members()}
        </Button>
      ) : null}
      {failed ? (
        <div role="alert" className="basis-full space-y-2 text-sm">
          <p>{m.library_collection_move_read_failed()}</p>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || loading}
            onClick={() => (destinationId ? void choose(destinationId) : void readChoices())}
          >
            {m.library_collection_move_retry()}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
