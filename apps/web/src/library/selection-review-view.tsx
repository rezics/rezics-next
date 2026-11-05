import { ResponsiveDialog } from '@rezics/ui/responsive-dialog';
import { Button } from '@rezics/ui/shadcn/button';
import { useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { m } from '../paraglide/messages.js';

export type SelectionReviewItem = Readonly<{
  subjectId: string;
  title: string;
  stateLabel?: string;
}>;

export function SelectionReviewList({
  items,
  labelledBy,
}: {
  items: readonly SelectionReviewItem[];
  labelledBy: string;
}) {
  return (
    <ol aria-label={labelledBy} className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-3">
      {items.map((item) => (
        <li key={item.subjectId} data-selection-review-entry={item.subjectId} className="min-w-0 space-y-1">
          <p className="break-words font-medium">{item.title}</p>
          <code className="block break-all text-xs text-muted-foreground">{item.subjectId}</code>
          {item.stateLabel ? <p className="text-sm text-muted-foreground">{item.stateLabel}</p> : null}
        </li>
      ))}
    </ol>
  );
}

export function SelectionReviewView({
  open,
  onOpenChange,
  items,
  actionMeaning,
  statusChoices,
  statusValue,
  statusAllowed,
  statusBlocked,
  pending,
  hydrated,
  episodeKey,
  onStatusChange,
  onReviewStatus,
  launcher,
  isCurrent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly SelectionReviewItem[];
  actionMeaning?: ReactNode;
  statusChoices: readonly { id: string; label: { text: string; lang: string } }[];
  statusValue: string;
  statusAllowed: boolean;
  statusBlocked: boolean;
  pending: boolean;
  hydrated: boolean;
  episodeKey: string;
  onStatusChange: (value: string) => void;
  onReviewStatus: () => void;
  launcher: RefObject<HTMLButtonElement | null>;
  isCurrent: () => boolean;
}) {
  const observedEpisodeKey = useRef(episodeKey);
  const episodeEpoch = useRef(0);
  if (observedEpisodeKey.current !== episodeKey) {
    observedEpisodeKey.current = episodeKey;
    episodeEpoch.current += 1;
  }
  const activeEpisode = useRef<{ key: string; epoch: number } | null>(
    open ? { key: episodeKey, epoch: episodeEpoch.current } : null,
  );
  const previousOpen = useRef(open);
  if (open && !previousOpen.current) activeEpisode.current = { key: episodeKey, epoch: episodeEpoch.current };
  previousOpen.current = open;
  const isCurrentEpisode = () =>
    activeEpisode.current?.key === episodeKey && activeEpisode.current.epoch === episodeEpoch.current;
  const current = open && isCurrentEpisode() && isCurrent();
  const selectedChoice = statusChoices.find((choice) => choice.id === statusValue);
  const canReviewStatus =
    statusAllowed && !statusBlocked && !pending && hydrated && !!selectedChoice && items.length > 0;
  const close = (next: boolean) => {
    if (!isCurrent() || (!next && !isCurrentEpisode())) return;
    onOpenChange(next);
  };
  const returnFocus = () =>
    isCurrentEpisode() && isCurrent() && launcher.current?.isConnected ? launcher.current : false;
  const summary = (
    <>
      <p role="status" className="text-sm">
        {m.library_selection_count({ count: items.length })}
      </p>
      {actionMeaning ? <p>{actionMeaning}</p> : null}
      <SelectionReviewList items={items} labelledBy={m.library_selection_heading()} />
      <section aria-label={m.library_menu_status()} className="space-y-2">
        <label className="grid gap-2 text-sm">
          {m.library_selection_state()}
          <select
            aria-label={m.library_selection_state()}
            className="min-h-11 w-full rounded-md border bg-background px-3"
            value={statusValue}
            disabled={!statusAllowed || statusBlocked || pending || !hydrated}
            onChange={(event) => onStatusChange(event.target.value)}
          >
            <option value="">{m.library_selection_choose()}</option>
            {statusChoices.map((choice) => (
              <option key={choice.id} value={choice.id} lang={choice.label.lang}>
                {choice.label.text}
              </option>
            ))}
          </select>
        </label>
        {!statusAllowed ? <p role="status">{m.library_selection_status_unavailable()}</p> : null}
        {statusAllowed && statusBlocked ? <p role="status">{m.library_selection_unknown()}</p> : null}
        {statusAllowed && !statusBlocked && !statusChoices.length ? (
          <p role="status">{m.library_selection_no_common()}</p>
        ) : null}
        <Button className="min-h-11 w-full sm:w-auto" disabled={!canReviewStatus} onClick={onReviewStatus}>
          {m.library_bulk_status_review()}
        </Button>
      </section>
    </>
  );

  return (
    <ResponsiveDialog
      open={current}
      onOpenChange={close}
      title={m.library_selection_review_title()}
      description={m.library_selection_review_description()}
      closeLabel={m.library_selection_review_close()}
      className="sm:max-w-lg"
      finalFocus={returnFocus}
    >
      <div className="space-y-4">{current ? summary : null}</div>
    </ResponsiveDialog>
  );
}
