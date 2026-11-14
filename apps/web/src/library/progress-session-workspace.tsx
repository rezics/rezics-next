import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { BottomSheet } from '@rezics/ui/bottom-sheet';
import { Button } from '@rezics/ui/shadcn/button';
import { Dialog, DialogContent, DialogTitle } from '@rezics/ui/shadcn/dialog';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';

/** Presentation frame for one loaded Progress session. State and navigation decisions stay with its owner. */
export function ProgressSessionWorkspace({
  identity,
  returnControls,
  taskHeading,
  taskStatus,
  taskActions,
  secondary,
  changes,
  units,
  logs,
  editor,
  editing,
  phone,
  alert,
  idempotencyKey,
  taskOpenerRef,
  onEditorOpenChange,
}: {
  identity: ReactNode;
  returnControls: ReactNode;
  taskHeading: ReactNode;
  taskStatus?: ReactNode;
  taskActions: ReactNode;
  secondary?: ReactNode;
  changes: ReactNode;
  units: ReactNode;
  logs?: ReactNode;
  editor: ReactNode;
  editing: boolean;
  phone: boolean;
  alert: string | null;
  idempotencyKey: string;
  taskOpenerRef: { current: HTMLButtonElement | null };
  onEditorOpenChange: (open: boolean) => void;
}) {
  const taskHeadingId = useId();
  const taskHeadingRef = useRef<HTMLHeadingElement>(null);
  const wasEditing = useRef(editing);

  useLayoutEffect(() => {
    if (wasEditing.current && !editing) {
      const opener = taskOpenerRef.current;
      if (opener?.isConnected) opener.focus();
      else taskHeadingRef.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing, taskOpenerRef]);

  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-6">
        <PageHeading>{m.library_progress_heading()}</PageHeading>
        {returnControls}
        {identity}
      </header>

      <section aria-labelledby={taskHeadingId} className="space-y-4 rounded-xl border border-border bg-muted/10 p-4">
        <h2 ref={taskHeadingRef} id={taskHeadingId} tabIndex={-1} className="text-xl font-semibold">
          {taskHeading}
        </h2>
        {taskStatus}
        <div className="flex flex-wrap items-center gap-2">{taskActions}</div>
      </section>

      {secondary ? <section className="space-y-6">{secondary}</section> : null}

      <div className="space-y-8">
        {changes}
        {units}
        {logs}
      </div>

      {editing ? (
        phone ? (
          <BottomSheet
            open={editing}
            onOpenChange={onEditorOpenChange}
            title={m.library_progress_update()}
          >
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            {alert ? (
              <p role="alert" className="rounded-lg border border-border bg-card p-3">
                {alert}
              </p>
            ) : null}
            {editor}
          </BottomSheet>
        ) : (
          <Dialog open={editing} onOpenChange={onEditorOpenChange}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
              <DialogTitle>{m.library_progress_update()}</DialogTitle>
              <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
              {alert ? (
                <p role="alert" className="rounded-lg border border-border bg-card p-3">
                  {alert}
                </p>
              ) : null}
              {editor}
            </DialogContent>
          </Dialog>
        )
      ) : null}
    </article>
  );
}

