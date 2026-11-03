import { useEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { readCollectionDestination, type CollectionDestination } from './collection-read';
import {
  readCollectionMoveChoices,
  readCollectionMovePlacements,
  type MoveChoices,
  type MovePlacements,
} from './collection-move-read';
import {
  firstPageVisit,
  moveReadFailure,
  nextPageVisit,
  previousPageVisit,
  type BoundedPageVisit,
} from './collection-placement-journey/model';

export type CollectionMoveAnchor = Readonly<{ id: string; title: string; page: number; position: number }>;
export type CollectionMoveChoice = Readonly<{
  destination: CollectionDestination;
  after: string | null;
  anchor: CollectionMoveAnchor | null;
}>;

const controlClass =
  'min-h-11 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] text-left focus-visible:outline-2 focus-visible:outline-offset-2';
const linkClass =
  'min-h-11 max-w-full break-words [overflow-wrap:anywhere] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2';

type ReadIssue = 'denied' | 'expired' | 'changed' | 'unavailable';

function issueMessage(issue: ReadIssue) {
  switch (issue) {
    case 'denied':
      return m.library_collection_move_denied();
    case 'expired':
      return m.library_collection_move_expired();
    case 'changed':
      return m.library_collection_move_destination_changed();
    default:
      return m.library_collection_move_read_failed();
  }
}

function collectionAddress(id: string) {
  return `/${getLocale()}/collections/${encodeURIComponent(id)}`;
}

export function CollectionMoveChooser({
  sourceId,
  disabled,
  current,
  onChange,
  placement = true,
  focusHeadingOnMount = false,
}: {
  sourceId: string;
  disabled: boolean;
  current: () => boolean;
  onChange: (choice: CollectionMoveChoice | null) => void;
  /** Bulk add captures a destination only; its native executor determines placement. */
  placement?: boolean;
  /** Return focus to the chooser after a review panel closes. */
  focusHeadingOnMount?: boolean;
}) {
  const [choices, setChoices] = useState<MoveChoices>({ collections: [], next: null });
  const [choiceVisit, setChoiceVisit] = useState<BoundedPageVisit>(firstPageVisit);
  const [choiceIssue, setChoiceIssue] = useState<ReadIssue | null>(null);
  const [placements, setPlacements] = useState<MovePlacements>({ members: [], next: null });
  const [placementVisit, setPlacementVisit] = useState<BoundedPageVisit>(firstPageVisit);
  const [placementIssue, setPlacementIssue] = useState<ReadIssue | null>(null);
  const [destination, setDestination] = useState<CollectionDestination | null>(null);
  const [destinationId, setDestinationId] = useState('');
  const [selectedAnchor, setSelectedAnchor] = useState<CollectionMoveAnchor | null>(null);
  const selectionAdmitted = useRef(false);
  const [selectionReady, setSelectionReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const version = useRef(0);
  const live = useRef(false);
  const callbacks = useRef({ current, onChange });
  const destinationHeading = useRef<HTMLHeadingElement>(null);
  const placementHeading = useRef<HTMLHeadingElement>(null);
  const focusAfterEpisode = useRef<number | null>(null);
  callbacks.current = { current, onChange };
  const retained = (episode: number) => live.current && episode === version.current && callbacks.current.current();

  useEffect(() => {
    live.current = true;
    if (focusHeadingOnMount) destinationHeading.current?.focus();
    void readChoices(firstPageVisit(), false);
    return () => {
      live.current = false;
      version.current++;
    };
  }, []);

  useEffect(() => {
    const episode = focusAfterEpisode.current;
    if (episode === null || loading || !retained(episode)) return;
    focusAfterEpisode.current = null;
    if (destination && placement) placementHeading.current?.focus();
    else destinationHeading.current?.focus();
  }, [choices, placements, destination, choiceIssue, placementIssue, loading]);

  async function readChoices(visit: BoundedPageVisit, focus: boolean) {
    if (!callbacks.current.current()) return;
    const episode = ++version.current;
    if (focus) focusAfterEpisode.current = episode;
    setLoading(true);
    setChoiceIssue(null);
    try {
      const page = await readCollectionMoveChoices({ data: visit.cursor });
      if (!retained(episode)) return;
      const eligible = page.collections.filter((choice) => choice.id !== sourceId);
      setChoices(page);
      setChoiceVisit(visit);
      setChoiceIssue(null);
    } catch (error) {
      if (retained(episode)) setChoiceIssue(moveReadFailure(error));
    } finally {
      if (retained(episode)) setLoading(false);
    }
  }

  async function readPlacementPage(
    visit: BoundedPageVisit,
    target: CollectionDestination,
    focus: boolean,
    preserveSelection: boolean,
  ) {
    if (!callbacks.current.current()) return;
    const episode = ++version.current;
    if (focus) focusAfterEpisode.current = episode;
    setLoading(true);
    setPlacementIssue(null);
    try {
      const page = await readCollectionMovePlacements({
        data: { collectionId: target.id, revision: target.revision, cursor: visit.cursor },
      });
      if (!retained(episode)) return;
      setPlacements(page);
      setPlacementVisit(visit);
      setPlacementIssue(null);
      if (preserveSelection && selectionAdmitted.current) {
        callbacks.current.onChange({
          destination: target,
          after: selectedAnchor?.id ?? null,
          anchor: selectedAnchor,
        });
      }
    } catch (error) {
      if (!retained(episode)) return;
      const issue = moveReadFailure(error);
      setPlacementIssue(issue);
      selectionAdmitted.current = false;
      setSelectionReady(false);
      callbacks.current.onChange(null);
      if (issue === 'changed' || issue === 'denied') {
        setDestination(null);
        if (issue === 'denied') setDestinationId('');
        setSelectedAnchor(null);
        setPlacements({ members: [], next: null });
      }
    } finally {
      if (retained(episode)) setLoading(false);
    }
  }

  async function chooseDestination(id: string) {
    if (!callbacks.current.current()) return;
    const episode = ++version.current;
    focusAfterEpisode.current = episode;
    selectionAdmitted.current = false;
    setSelectionReady(false);
    setLoading(true);
    setPlacementIssue(null);
    setDestinationId(id);
    setDestination(null);
    setSelectedAnchor(null);
    setPlacements({ members: [], next: null });
    setPlacementVisit(firstPageVisit());
    callbacks.current.onChange(null);
    if (!id) {
      setLoading(false);
      setDestinationId('');
      return;
    }
    try {
      const target = await readCollectionDestination({ data: id });
      if (!retained(episode)) return;
      if (!target) throw new Error('Move destination unavailable');
      if (target.id !== id || target.id === sourceId) throw new Error('Move destination changed');
      if (placement) {
        const page = await readCollectionMovePlacements({ data: { collectionId: id, revision: target.revision } });
        if (!retained(episode)) return;
        setPlacements(page);
        setPlacementVisit(firstPageVisit());
      }
      setDestination(target);
      setPlacementIssue(null);
      selectionAdmitted.current = true;
      setSelectionReady(true);
      callbacks.current.onChange({ destination: target, after: null, anchor: null });
    } catch (error) {
      if (!retained(episode)) return;
      const issue = moveReadFailure(error);
      setPlacementIssue(issue);
      selectionAdmitted.current = false;
      setSelectionReady(false);
      callbacks.current.onChange(null);
      if (issue === 'denied') setDestinationId('');
    } finally {
      if (retained(episode)) setLoading(false);
    }
  }

  function chooseStart() {
    if (!destination || !callbacks.current.current() || loading) return;
    selectionAdmitted.current = true;
    setSelectionReady(true);
    setSelectedAnchor(null);
    setPlacementIssue(null);
    callbacks.current.onChange({ destination, after: null, anchor: null });
  }

  function chooseAnchor(member: MovePlacements['members'][number], index: number) {
    if (!destination || !callbacks.current.current() || loading) return;
    const anchor: CollectionMoveAnchor = {
      id: member.id,
      title: member.title,
      page: placementVisit.page,
      position: index + 1,
    };
    selectionAdmitted.current = true;
    setSelectionReady(true);
    setSelectedAnchor(anchor);
    setPlacementIssue(null);
    callbacks.current.onChange({ destination, after: anchor.id, anchor });
  }

  function clearDestination() {
    if (!callbacks.current.current()) return;
    const episode = ++version.current;
    focusAfterEpisode.current = episode;
    selectionAdmitted.current = false;
    setSelectionReady(false);
    setDestination(null);
    setDestinationId('');
    setSelectedAnchor(null);
    setPlacements({ members: [], next: null });
    setPlacementVisit(firstPageVisit());
    setPlacementIssue(null);
    callbacks.current.onChange(null);
    destinationHeading.current?.focus();
  }

  function restartChoices() {
    void readChoices(firstPageVisit(), true);
  }

  function restartPlacements() {
    if (!destination) {
      if (destinationId) void chooseDestination(destinationId);
      return;
    }
    const preserveSelection = placementIssue === null && selectionAdmitted.current;
    if (placementIssue) {
      selectionAdmitted.current = false;
      setSelectionReady(false);
    }
    void readPlacementPage(firstPageVisit(), destination, true, preserveSelection);
  }

  function retryChoicePage() {
    void readChoices(choiceVisit, true);
  }

  function retryPlacementPage() {
    if (!destination) {
      if (destinationId) void chooseDestination(destinationId);
      return;
    }
    if (placementIssue === 'expired' || placementIssue === 'changed' || placementIssue === 'denied') {
      restartPlacements();
      return;
    }
    selectionAdmitted.current = false;
    setSelectionReady(false);
    const preserveSelection = false;
    void readPlacementPage(placementVisit, destination, true, preserveSelection);
  }

  const visibleChoices = choices.collections.filter((choice) => choice.id !== sourceId);
  const destinationUrl = destination ? collectionAddress(destination.id) : '';

  return (
    <section
      className="flex min-w-0 basis-full flex-wrap items-start gap-3"
      data-collection-move-chooser
      aria-busy={loading}
    >
      <div className="min-w-0 basis-full space-y-2">
        <h3 ref={destinationHeading} tabIndex={-1} className="font-medium">
          {m.library_collection_move_destination()}
        </h3>
        {loading && !destination ? <p role="status">{m.library_collection_move_loading()}</p> : null}
        {visibleChoices.length ? (
          <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
            {visibleChoices.map((choice) => (
              <li key={choice.id} className="min-w-0">
                <Button
                  type="button"
                  variant={destinationId === choice.id ? 'default' : 'outline'}
                  className={`${controlClass} w-full justify-start px-3 py-2`}
                  data-move-destination={choice.id}
                  disabled={disabled || loading}
                  aria-pressed={destinationId === choice.id}
                  onClick={() => void chooseDestination(choice.id)}
                >
                  {choice.title}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {!loading && !choiceIssue && visibleChoices.length === 0 ? (
          <p role="status">
            {choices.next
              ? m.library_collection_move_sparse_destination_page()
              : choiceVisit.page > 1
                ? m.library_collection_move_exhausted()
                : m.library_collection_move_no_destinations()}
          </p>
        ) : null}
        {!loading && !choiceIssue && visibleChoices.length > 0 && choiceVisit.page > 1 && !choices.next ? (
          <p role="status">{m.library_collection_move_exhausted()}</p>
        ) : null}
        {choiceIssue ? (
          <div role="alert" className="space-y-2 text-sm">
            <p>{issueMessage(choiceIssue)}</p>
            <Button
              type="button"
              variant="outline"
              className={controlClass}
              disabled={disabled || loading}
              onClick={choiceIssue === 'expired' ? restartChoices : retryChoicePage}
            >
              {choiceIssue === 'expired' ? m.library_collection_move_restart() : m.library_collection_move_retry()}
            </Button>
          </div>
        ) : null}
        {placementIssue && !destination ? (
          <div role="alert" className="space-y-2 text-sm">
            <p>{issueMessage(placementIssue)}</p>
            <Button
              type="button"
              variant="outline"
              className={controlClass}
              disabled={disabled || loading}
              onClick={() => {
                if (destinationId) void chooseDestination(destinationId);
                else restartChoices();
              }}
            >
              {destinationId ? m.library_collection_move_reread_destination() : m.library_collection_move_retry()}
            </Button>
          </div>
        ) : null}
        <div className="flex min-w-0 flex-wrap gap-2">
          {choiceVisit.canGoPrevious ? (
            <Button
              type="button"
              variant="outline"
              className={controlClass}
              disabled={disabled || loading || !previousPageVisit(choiceVisit)}
              onClick={() => {
                const previous = previousPageVisit(choiceVisit);
                if (previous) void readChoices(previous, true);
              }}
            >
              {m.library_collection_move_previous()}
            </Button>
          ) : null}
          {choiceVisit.page > 1 ? (
            <Button
              type="button"
              variant="outline"
              className={controlClass}
              disabled={disabled || loading}
              onClick={restartChoices}
            >
              {m.library_collection_move_restart()}
            </Button>
          ) : null}
          {choices.next && !choiceIssue ? (
            <Button
              type="button"
              variant="outline"
              className={controlClass}
              disabled={disabled || loading}
              onClick={() => void readChoices(nextPageVisit(choiceVisit, choices.next), true)}
            >
              {m.library_collection_move_more_destinations()}
            </Button>
          ) : null}
        </div>
      </div>

      {destination && placement ? (
        <div className="min-w-0 basis-full space-y-2 border-t pt-3" data-placement-browse>
          <h3 ref={placementHeading} tabIndex={-1} className="font-medium">
            {m.library_collection_move_placement()}
          </h3>
          <p className="break-words text-sm [overflow-wrap:anywhere]">
            {destination.title}{' '}
            <a href={destinationUrl} className={linkClass}>
              {m.library_collection_move_open_destination()}
            </a>
          </p>
          <Button
            type="button"
            variant={selectedAnchor === null && selectionReady ? 'default' : 'outline'}
            className={controlClass}
            disabled={disabled || loading || !!placementIssue}
            aria-pressed={selectedAnchor === null && selectionReady}
            onClick={chooseStart}
          >
            {m.library_collection_move_first()}
          </Button>
          {placements.members.length ? (
            <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
              {placements.members.map((member, index) => (
                <li key={member.id} className="min-w-0">
                  <Button
                    type="button"
                    variant={selectedAnchor?.id === member.id && selectionReady ? 'default' : 'outline'}
                    className={`${controlClass} w-full justify-start px-3 py-2`}
                    data-move-anchor={member.id}
                    disabled={disabled || loading || !!placementIssue}
                    aria-pressed={selectedAnchor?.id === member.id && selectionReady}
                    onClick={() => chooseAnchor(member, index)}
                  >
                    <span>{m.library_collection_move_after_page({ position: index + 1, title: member.title })}</span>
                    <code className="ms-2 text-xs">{member.id}</code>
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p role="status">{m.library_collection_move_no_anchors()}</p>
          )}
          {!loading && placementVisit.page > 1 && !placements.next ? (
            <p role="status">{m.library_collection_move_exhausted()}</p>
          ) : null}
          {selectedAnchor ? (
            <div className="min-w-0 rounded-lg bg-muted/40 p-3 text-sm" data-selected-move-anchor>
              <p>
                {m.library_collection_move_anchor_review({
                  page: selectedAnchor.page,
                  position: selectedAnchor.position,
                  title: selectedAnchor.title,
                })}
              </p>
              <code className="break-all">{selectedAnchor.id}</code>
              {!selectionReady ? <p>{m.library_collection_move_reselect_anchor()}</p> : null}
            </div>
          ) : null}
          {placementIssue ? (
            <div role="alert" className="space-y-2 text-sm">
              <p>{issueMessage(placementIssue)}</p>
              <Button
                type="button"
                variant="outline"
                className={controlClass}
                disabled={disabled || loading}
                onClick={
                  placementIssue === 'changed' || placementIssue === 'denied' ? retryPlacementPage : restartPlacements
                }
              >
                {placementIssue === 'changed' || placementIssue === 'denied'
                  ? m.library_collection_move_reread_destination()
                  : placementIssue === 'expired'
                    ? m.library_collection_move_restart()
                    : m.library_collection_move_retry()}
              </Button>
            </div>
          ) : null}
          <div className="flex min-w-0 flex-wrap gap-2">
            {placementVisit.canGoPrevious ? (
              <Button
                type="button"
                variant="outline"
                className={controlClass}
                disabled={disabled || loading}
                onClick={() => {
                  const previous = previousPageVisit(placementVisit);
                  if (previous) void readPlacementPage(previous, destination, true, selectionAdmitted.current);
                }}
              >
                {m.library_collection_move_previous()}
              </Button>
            ) : null}
            {placementVisit.page > 1 ? (
              <Button
                type="button"
                variant="outline"
                className={controlClass}
                disabled={disabled || loading}
                onClick={restartPlacements}
              >
                {m.library_collection_move_restart()}
              </Button>
            ) : null}
            {placements.next && !placementIssue ? (
              <Button
                type="button"
                variant="outline"
                className={controlClass}
                disabled={disabled || loading}
                onClick={() =>
                  void readPlacementPage(
                    nextPageVisit(placementVisit, placements.next),
                    destination,
                    true,
                    selectionAdmitted.current,
                  )
                }
              >
                {m.library_collection_move_more_members()}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {destination && placement ? (
        <Button
          type="button"
          variant="outline"
          className={controlClass}
          disabled={disabled || loading}
          onClick={clearDestination}
        >
          {m.library_collection_move_change_destination()}
        </Button>
      ) : null}
    </section>
  );
}
