import { useIsMobile } from '@rezics/ui/hooks/use-is-mobile';
import { BottomSheet } from '@rezics/ui/bottom-sheet';
import { Button } from '@rezics/ui/shadcn/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@rezics/ui/shadcn/dialog';
import type { RefObject } from 'react';
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
  onStatusChange,
  onReviewStatus,
  launcher,
  isCurrent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly SelectionReviewItem[];
  actionMeaning?: string;
  statusChoices: readonly { id: string; label: { text: string; lang: string } }[];
  statusValue: string;
  statusAllowed: boolean;
  statusBlocked: boolean;
  pending: boolean;
  hydrated: boolean;
  onStatusChange: (value: string) => void;
  onReviewStatus: () => void;
  launcher: RefObject<HTMLButtonElement | null>;
  isCurrent: () => boolean;
}) {
  const mobile = useIsMobile();
  const selectedChoice = statusChoices.find((choice) => choice.id === statusValue);
  const canReviewStatus =
    statusAllowed &&
    !statusBlocked &&
    !pending &&
    hydrated &&
    !!selectedChoice &&
    items.length > 0;
  const close = (next: boolean) => {
    onOpenChange(next);
    if (next) return;
    const restore = () => {
      if (isCurrent() && launcher.current?.isConnected) launcher.current.focus();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
    else queueMicrotask(restore);
  };
  const returnFocus = () => (isCurrent() && launcher.current?.isConnected ? launcher.current : false);
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

  if (mobile)
    return (
      <BottomSheet
        open={open}
        onOpenChange={close}
        title={m.library_selection_review_title()}
        closeLabel={m.library_selection_review_close()}
        finalFocus={returnFocus}
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{m.library_selection_review_description()}</p>
          {summary}
        </div>
      </BottomSheet>
    );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg" finalFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>{m.library_selection_review_title()}</DialogTitle>
          <DialogDescription>{m.library_selection_review_description()}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">{summary}</div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" className="min-h-11" />}>{m.library_selection_review_close()}</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
